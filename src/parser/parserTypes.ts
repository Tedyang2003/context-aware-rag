import type { FileHandle, PromptPreprocessorController } from "@lmstudio/sdk";

export interface ParseContext {
  ctl: PromptPreprocessorController;
  filePath: string; // resolved local path, or file.name as fallback
}

export type ParseResult =
  | { success: true; content: string; parserName: string; isCustomExtraction: boolean }
  | { success: false; reason: string };

export interface Parser {
  /** Unique name, used in status text / debug logs / cache metadata */
  name: string;
  /** Whether this parser should be attempted for this file */
  canParse(file: FileHandle, ctx: ParseContext): boolean | Promise<boolean>;
  /** Whether the result from a previous parser is "good enough" to skip this one */
  shouldSkip?(previousResult: ParseResult | undefined, file: FileHandle, ctx: ParseContext): boolean;
  parse(file: FileHandle, ctx: ParseContext): Promise<ParseResult>;
}

