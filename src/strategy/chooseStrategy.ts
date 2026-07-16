import {
    type FileHandle,
    type PromptPreprocessorController,
} from "@lmstudio/sdk";
import { measureContextWindow } from "../context/measureContext";
import { DocumentContextInjectionStrategy } from "../types/types";
import { parseFile } from "../parser/parseFile";


// Choose context injection strategy
export async function chooseContextInjectionStrategy(
    ctl: PromptPreprocessorController,
    originalUserPrompt: string,
    files: Array<FileHandle>,
): Promise<DocumentContextInjectionStrategy> {
    

    // Measure the current context window to determine how much space is available for new content
    const model = await ctl.client.llm.model();
    const ctx = await ctl.pullHistory();


    const {
        totalTokensInContext,
        modelContextLength,
        modelRemainingContextLength,
        contextOccupiedPercent,
    } = await measureContextWindow(ctx, model, ctl);

    ctl.debug(
        `Context measurement result:\n\n` +
        `\tTotal tokens in context: ${totalTokensInContext}\n` +
        `\tModel context length: ${modelContextLength}\n` +
        `\tModel remaining context length: ${modelRemainingContextLength}\n` +
        `\tContext occupied percent: ${contextOccupiedPercent.toFixed(2)}%\n`,
    );

    // Measure the total token count of all files to determine if they can fit into the remaining context window
    let totalFileTokenCount = 0;
    let totalReadTime = 0;
    let totalTokenizeTime = 0;
    for (const file of files) {
        const startTime = performance.now();

        // parse content with OCR fallback
        const { content } = await parseFile(ctl, file);

        totalReadTime += performance.now() - startTime;

        const startTokenizeTime = performance.now();
        totalFileTokenCount += await model.countTokens(content);

        totalTokenizeTime += performance.now() - startTokenizeTime;
        if (totalFileTokenCount > modelRemainingContextLength) {
            break;
        }
    }


    ctl.debug(`Total file read time: ${totalReadTime.toFixed(2)} ms`);
    ctl.debug(`Total tokenize time: ${totalTokenizeTime.toFixed(2)} ms`);
    ctl.debug(`Original User Prompt: ${originalUserPrompt}`);

    // Measure the token count of the user prompt to determine if it can fit into the remaining context window
    const userPromptTokenCount = (await model.tokenize(originalUserPrompt)).length;
    const totalFilePlusPromptTokenCount = totalFileTokenCount + userPromptTokenCount;

    const contextOccupiedFraction = contextOccupiedPercent / 100;
    const targetContextUsePercent = 0.7;
    const targetContextUsage = targetContextUsePercent * (1 - contextOccupiedFraction);
    const availableContextTokens = Math.floor(modelRemainingContextLength * targetContextUsage);

    ctl.debug("Strategy Calculation:");
    ctl.debug(`\tTotal Tokens in All Files: ${totalFileTokenCount}`);
    ctl.debug(`\tTotal Tokens in User Prompt: ${userPromptTokenCount}`);
    ctl.debug(`\tModel Context Remaining: ${modelRemainingContextLength} tokens`);
    ctl.debug(`\tContext Occupied: ${contextOccupiedPercent.toFixed(2)}%`);
    ctl.debug(`\tAvailable Tokens: ${availableContextTokens}\n`);


    const status = ctl.createStatus({
        status: "loading",
        text: `Deciding injection strategy for the document(s)...`,
    });


    // Select Strategy based on token counts and available context
    if (totalFilePlusPromptTokenCount > availableContextTokens) {
        const chosenStrategy = "retrieval";
        ctl.debug(
            `Chosen context injection strategy: '${chosenStrategy}'. Total file + prompt token count: ` +
            `${totalFilePlusPromptTokenCount} > ${targetContextUsage * 100
            }% * available context tokens: ${availableContextTokens}`,
        );
        status.setState({
            status: "done",
            text: `Chosen context injection strategy: '${chosenStrategy}'. Retrieval is optimal for the size of content provided`,
        });
        return chosenStrategy;
    }

    const chosenStrategy = "inject-full-content";
    status.setState({
        status: "done",
        text: `Chosen context injection strategy: '${chosenStrategy}'. All content can fit into the context`,
    });
    return chosenStrategy;
}