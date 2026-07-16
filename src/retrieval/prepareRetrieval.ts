import {
    type FileHandle,
    type PredictionProcessStatusController,
    type PromptPreprocessorController,
    type RetrievalResultEntry
} from "@lmstudio/sdk";
import { configSchematics } from "../config";
import { embedCustomParsedFiles } from "../retrieval/embedCustomParsedFiles";
import { parseFile } from "../parser/parseFile";

export async function prepareRetrievalResultsContextInjection(
    ctl: PromptPreprocessorController,
    originalUserPrompt: string,
    files: Array<FileHandle>,
): Promise<string> {
    const pluginConfig = ctl.getPluginConfig(configSchematics);
    const retrievalLimit = pluginConfig.get("retrievalLimit");
    const retrievalAffinityThreshold = pluginConfig.get("retrievalAffinityThreshold");

    const statusSteps = new Map<FileHandle, PredictionProcessStatusController>();

    const retrievingStatus = ctl.createStatus({
        status: "loading",
        text: `Loading an embedding model for retrieval...`,
    });
    const model = await ctl.client.embedding.model("nomic-ai/nomic-embed-text-v1.5-GGUF", {
        signal: ctl.abortSignal,
    });

    const normalFiles: Array<FileHandle> = [];
    const customFiles: Array<{ file: FileHandle; content: string }> = [];

    for (const file of files) {
        const parsed = await parseFile(ctl, file);
        if (parsed.customParsed) {
            customFiles.push({ file, content: parsed.content });
        } else {
            normalFiles.push(file);
        }
    }
    retrievingStatus.setState({
        status: "loading",
        text: `Retrieving relevant citations for user query...`,
    });

    type SdkResult = Awaited<ReturnType<typeof ctl.client.files.retrieve>>;
    type SdkEntry = SdkResult["entries"][number];

    let sdkResult: SdkResult | null = null;

    // Each merged entry carries content/score for sorting+display, plus an
    // optional back-reference to the original (untouched) SDK entry object
    // so we can hand it back to addCitations with its original type intact.
    type MergedEntry = { content: string; score: number; sdkRef?: SdkEntry; sourceFile?: FileHandle };
    let entries: MergedEntry[] = [];

    if (normalFiles.length > 0) {
        sdkResult = await ctl.client.files.retrieve(originalUserPrompt, normalFiles, {
            embeddingModel: model,
            limit: retrievalLimit,
            signal: ctl.abortSignal,
            onFileProcessList(filesToProcess) {
                for (const file of filesToProcess) {
                    statusSteps.set(
                        file,
                        retrievingStatus.addSubStatus({
                            status: "waiting",
                            text: `Process ${file.name} for retrieval`,
                        }),
                    );
                }
            },
            onFileProcessingStart(file) {
                statusSteps.get(file)!.setState({ status: "loading", text: `Processing ${file.name} for retrieval` });
            },
            onFileProcessingEnd(file) {
                statusSteps.get(file)!.setState({ status: "done", text: `Processed ${file.name} for retrieval` });
            },
            onFileProcessingStepProgress(file, step, progressInStep) {
                const verb = step === "loading" ? "Loading" : step === "chunking" ? "Chunking" : "Embedding";
                statusSteps.get(file)!.setState({
                    status: "loading",
                    text: `${verb} ${file.name} for retrieval (${(progressInStep * 100).toFixed(1)}%)`,
                });
            },
        });
        entries = sdkResult.entries.map(e => ({ content: e.content, score: e.score, sdkRef: e }));
    }

    if (customFiles.length > 0) {
        const customSubStatus = retrievingStatus.addSubStatus({
            status: "loading",
            text: `Embedding custom-parsed content (${customFiles.map(f => f.file.name).join(", ")})...`,
        });
        const customEntries = await embedCustomParsedFiles(ctl, originalUserPrompt, customFiles, model);
        entries = entries.concat(
            customEntries.map(e => ({ content: e.content, score: e.score, sourceFile: e.file }))
        );
        customSubStatus.setState({ status: "done", text: `Embedded custom-parsed content` });
    }
    
    entries = entries
        .filter(entry => entry.score > retrievalAffinityThreshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, retrievalLimit);

    let processedContent = "";
    const numRetrievals = entries.length;

    if (numRetrievals > 0) {
        retrievingStatus.setState({
            status: "done",
            text: `Retrieved ${numRetrievals} relevant citations for user query`,
        });
        ctl.debug("Retrieval results (merged)", entries);
        const prefix = "The following citations were found in the files provided by the user:\n\n";
        processedContent += prefix;
        entries.forEach((entry, i) => {
            processedContent += `Citation ${i + 1}: "${entry.content}"\n\n`;
        });

        const citationEntries: RetrievalResultEntry[] = entries.map(e => {
            if (e.sdkRef) return e.sdkRef; // native SDK entries, unchanged
            return { content: e.content, score: e.score, source: e.sourceFile! }; // manually built for OCR
        });
        await ctl.addCitations({ entries: citationEntries });

        const suffix =
            `Use the citations above to respond to the user query, only if they are relevant. ` +
            `Otherwise, respond to the best of your ability without them.` +
            `\n\nUser Query:\n\n${originalUserPrompt}`;
        processedContent += suffix;
    } else {
        retrievingStatus.setState({
            status: "canceled",
            text: `No relevant citations found for user query`,
        });
        const noteAboutNoRetrievalResultsFound =
            `Important: No citations were found in the user files for the user query. ` +
            `In less than one sentence, inform the user of this. ` +
            `Then respond to the query to the best of your ability.`;
        processedContent = noteAboutNoRetrievalResultsFound + `\n\nUser Query:\n\n${originalUserPrompt}`;
    }
    ctl.debug("Processed content", processedContent);

    return processedContent;
}