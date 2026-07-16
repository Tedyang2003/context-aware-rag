import type { FileHandle } from "@lmstudio/sdk";

export type CachedChunk = {
    chunk: string;
    embedding: number[];
};

export type DocumentContextInjectionStrategy = "none" | "inject-full-content" | "retrieval";
export type ParsedFile = {
    content: string;
    ocrApplied: boolean;
    customParsed: boolean;
    // Add this field to hold your in-memory database right inside the text cache
    cachedChunks?: CachedChunk[];
};

export type ScoredEntry = { content: string; score: number; fileName?: string };

export type CustomParsedScoredEntry = { 
    content: string; 
    score: number; 
    file: FileHandle; 
};