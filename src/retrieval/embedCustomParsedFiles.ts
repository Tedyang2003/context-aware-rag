import {
    type EmbeddingDynamicHandle,
    type FileHandle,
    type PromptPreprocessorController,
} from "@lmstudio/sdk";
import { globalCache } from "../parser/parseFile"; // Import your existing text cache
import type { CustomParsedScoredEntry, CachedChunk } from "../types/types";
import { cosineSimilarity } from "./similarity";
import { chunkText } from './chunkText';

export async function embedCustomParsedFiles(
    ctl: PromptPreprocessorController,
    originalUserPrompt: string,
    customFiles: Array<{ file: FileHandle; content: string }>,
    embeddingModel: EmbeddingDynamicHandle,
): Promise<CustomParsedScoredEntry[]> {
    if (customFiles.length === 0) return [];

    // Embed the user prompt every turn
    const { embedding: queryEmbedding } = await embeddingModel.embed(originalUserPrompt);
    const scoredEntries: CustomParsedScoredEntry[] = [];

    for (const { file, content } of customFiles) {
        let filePath: string;
        try {
            filePath = await file.getFilePath();
        } catch {
            filePath = file.name;
        }

        // 1. Grab the existing text cache entry
        const cachedFileEntry = globalCache.get(filePath);

        if (cachedFileEntry) {
            // 2. If vectors haven't been computed for this cached text yet, do it now
            if (!cachedFileEntry.cachedChunks) {
                const chunks = chunkText(content);
                if (chunks.length > 0) {
                    const chunkEmbeddings = await embeddingModel.embed(chunks);
                    
                    // Store text and vector math together
                    cachedFileEntry.cachedChunks = chunks.map((chunk, index) => ({
                        chunk,
                        embedding: chunkEmbeddings[index].embedding,
                    }));
                } else {
                    cachedFileEntry.cachedChunks = [];
                }
            }

            // 3. Score the chunks using the unified cache storage
            for (const cached of cachedFileEntry.cachedChunks) {
                scoredEntries.push({
                    content: cached.chunk,
                    score: cosineSimilarity(queryEmbedding, cached.embedding),
                    file: file,
                });
            }
        }
    }

    return scoredEntries;
}