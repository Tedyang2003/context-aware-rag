import type { FileHandle, PromptPreprocessorController } from "@lmstudio/sdk";
import type { ParsedFile } from "../types/types";
import { createDefaultChain } from "../parser/parserIndex";


export const globalCache = new Map<string, ParsedFile>();
const chain = createDefaultChain();

export async function parseFile(
    ctl: PromptPreprocessorController,
    file: FileHandle,
): Promise<ParsedFile> {
    let filePath: string;
    try {
        filePath = await file.getFilePath();
    } catch {
        filePath = file.name;
    }


    const cached = globalCache.get(filePath);
    if (cached !== undefined) return cached;

    const result = await chain.run(file, { ctl, filePath });

    if (!result.success) {
        // Don't cache failures: a transient error (aborted OCR, file not yet
        // flushed to disk, etc.) shouldn't permanently poison this file path
        // for the rest of the process lifetime. Let the next call retry.
        return { content: "", ocrApplied: false, customParsed: false };
    }

    const parsed: ParsedFile = {
        content: result.content,
        ocrApplied: result.parserName === "ocr-pdf",
        customParsed: result.isCustomExtraction,
    };

    globalCache.set(filePath, parsed);

    return parsed;
}