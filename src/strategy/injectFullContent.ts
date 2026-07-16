import {
    text,
    type ChatMessage,
    type FileHandle,
    type PromptPreprocessorController,
} from "@lmstudio/sdk";
import { parseFile } from "../parser/parseFile";

export async function prepareDocumentContextInjection(
    ctl: PromptPreprocessorController,
    input: ChatMessage,
): Promise<ChatMessage> {
    const documentInjectionSnippets: Map<FileHandle, string> = new Map();
    const files = input.consumeFiles(ctl.client, file => file.type !== "image");
    for (const file of files) {
        const { content } = await parseFile(ctl, file);
        ctl.debug(text`
        Strategy: inject-full-content. Injecting full content of file '${file}' into the
        context. Length: ${content.length}.
    `);
        documentInjectionSnippets.set(file, content);
    }

    let formattedFinalUserPrompt = "";

    if (documentInjectionSnippets.size > 0) {
        formattedFinalUserPrompt +=
            "This is a Enriched Context Generation scenario.\n\nThe following content was found in the files provided by the user.\n";

        for (const [fileHandle, snippet] of documentInjectionSnippets) {
            formattedFinalUserPrompt += `\n\n** ${fileHandle.name} full content **\n\n${snippet}\n\n** end of ${fileHandle.name} **\n\n`;
        }
        formattedFinalUserPrompt += `Based on the content above, please provide a response to the user query.\n\nUser query: ${input.getText()}`;
        
    }

    input.replaceText(formattedFinalUserPrompt);
    return input;
}