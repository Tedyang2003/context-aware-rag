# Context-Aware RAG Plugin for LM Studio

A modified version of the RAG v1 preprocessor plugin for LM Studio, built for SAIC. Instead of always injecting full file content or always running retrieval, this plugin measures the model's actual available context window on every turn and picks whichever strategy fits — including a local OCR fallback for scanned/flat PDFs and dedicated text extractors for PPTX and DOCX.

## Features

- **Dynamic Context Engineering**: Measures the active model's context window (tokens used, tokens remaining) and routes attached documents to either full-content injection or vector retrieval based on a configurable occupancy budget — no fixed file-size cutoff.
- **Strategy Flips as Conversation Grows**: The same file can be injected in full early in a chat and automatically switch to retrieval later in the same conversation once the context window fills up with history.
- **Intelligent OCR Fallback**: PDFs are first parsed via LM Studio's native document parser; if that yields under 50 characters of text (a strong signal of a scanned/flat image PDF), a local MuPDF-rendered, Tesseract-OCR'd fallback recovers the text.
- **Dedicated PPTX/DOCX Extractors**: Slide and document XML (`<a:t>` / `<w:t>` text runs) are parsed directly from the underlying Office Open XML — no OCR needed, and speaker notes / headers / footers are included.
- **Persistent Module-Scoped Cache**: Parsed (and OCR'd) text is cached in memory by resolved file path for the life of the plugin process, so a file attached across multiple turns is never re-parsed or re-OCR'd. Failures are never cached, so a transient error can be retried.
- **Hybrid Retrieval Engine**: Combines LM Studio's native file retrieval (for normally-parsed files) with custom chunk + cosine-similarity scoring (for OCR/PPTX/DOCX-parsed files, computed with the Nomic embedding model), merges both result sets, filters by affinity threshold, and returns the top-scoring citations.
- **Image-Safe**: Image attachments are filtered out of every code path (strategy selection, injection, retrieval) — only non-image files are ever parsed or embedded.
- **Offline OCR Assets**: `eng.traineddata` ships in the repo and is copied into the installed plugin directory by `npm run install-plugin`, so Tesseract doesn't need to fetch the language pack from the network on first use.

## Supported File Types

- **Dedicated extractors**: `.pdf` (native parser, with OCR fallback for scanned/flat PDFs), `.pptx` (slide + speaker notes text), `.docx` (paragraphs, tables, headers/footers)
- **Everything else** (`.txt`, `.md`, `.csv`, etc.): handled entirely by LM Studio's native `files.parseDocument` — there's no custom fallback for these, so support depends on what LM Studio's built-in parser understands
- **Images**: always excluded — never parsed, injected, or retrieved

## Installation

1. Install dependencies:
```bash
npm install
```

2. Run in development mode (hot-reloads into a running LM Studio instance):
```bash
npm run dev
```

3. Install the plugin (and copy the OCR language pack into the installed plugin directory):
```bash
npm run install-plugin
```

## Configuration

The plugin exposes three settings in LM Studio:

- **Retrieval Limit** (default: 3): Maximum number of chunks/citations returned when retrieval is triggered.
- **Retrieval Affinity Threshold** (0.0–1.0, default: 0.5): Minimum similarity score for a chunk to be considered relevant.
- **Enable OCR Fallback** (default: true): If a PDF has little to no extractable text (e.g. a scanned/flat document), run local OCR to recover it. Slower, but recovers text from image-based PDFs.

There is no configurable embedding model — retrieval always uses `nomic-ai/nomic-embed-text-v1.5-GGUF`, and it must be available/loadable in LM Studio.

## Usage

1. Attach one or more non-image files to a chat message and send it.
2. The plugin measures the model's current context window (tokens already used by history) and the token cost of the attached files:
   - The available budget for new content is `0.7 × remainingTokens × (1 − occupiedFraction)` — not a flat 70% of what's left. Since `remainingTokens` itself already shrinks as `occupiedFraction` grows, the effective budget collapses roughly quadratically as a conversation fills up, not linearly.
   - If everything (files + prompt) fits under that budget, the full text of every file is inlined directly into the prompt.
   - Otherwise, the plugin runs retrieval instead: relevant chunks are pulled via LM Studio's native retrieval (for normally-parsed files) and/or custom cosine-similarity scoring (for OCR/PPTX/DOCX content), merged, filtered by the affinity threshold, and injected as numbered citations.
3. If you send a **follow-up message with no new attachment**, files from earlier in the conversation are automatically routed through retrieval (never re-injected in full) so they don't keep consuming context on every turn.
4. If a PDF looks like a scanned/flat document (native parser returns under ~50 characters), OCR runs automatically (when enabled) — you'll see a status update while it processes each page.

## Architecture

### Components

1. **Prompt Preprocessor** (`src/promptPreprocessor.ts`):
   - Entry point LM Studio calls on every user turn
   - Splits files into "new to this message" vs "already in history", strips consumed files from their source message, and dispatches to the chosen strategy

2. **Strategy Selection** (`src/strategy/chooseStrategy.ts`, `src/context/measureContext.ts`):
   - `measureContextWindow` applies the model's prompt template to the current chat history to get an accurate token count, then computes remaining context length and occupancy percent
   - `chooseContextInjectionStrategy` parses every attached file (to get an accurate token count, using the same cache as everything else), adds the user prompt's token count, and compares the total against `0.7 × remainingTokens × (1 − occupiedFraction)` — a budget that shrinks roughly quadratically (not linearly) as the conversation fills up — to decide `inject-full-content` vs `retrieval`

3. **Full-Content Injection** (`src/strategy/injectFullContent.ts`):
   - Parses each file and inlines its complete text into the prompt, wrapped with clear per-file delimiters

4. **Parser Chain** (`src/parser/`):
   - `parserTypes.ts`: `Parser` interface (`canParse` / `shouldSkip` / `parse`) and the `ParseResult`/`ParseContext` shapes
   - `parserChain.ts`: `ParserChain` — runs registered parsers in order, skipping ones that don't apply or whose `shouldSkip` says the previous result is already good enough, returning the first success
   - `parserIndex.ts`: builds the default chain — `lmstudioParser` (catch-all, deferring to any "dedicated" parser that claims the file) → `ocrPdfParser` (PDF-only, only runs if the previous result was too short) → `pptxTextParser` → `docxTextParser`
   - `lmstudioParser.ts`: wraps LM Studio's native `files.parseDocument`
   - `ocrPdfParser.ts`: renders each PDF page via MuPDF at 2x scale and OCRs it with Tesseract (English, capped at 50 pages); only triggers when `enableOcrFallback` is on and the file is a `.pdf`
   - `pptxParser.ts` / `docxParser.ts`: extract `<a:t>`/`<w:t>` text runs directly from the slide/document XML inside the zip container (via `jszip`), grouped by paragraph, with speaker notes / headers / footers included
   - `parseFile.ts`: resolves each file's local path, checks the module-scoped `globalCache` first, otherwise runs the parser chain and caches the result (failures are never cached, so transient errors can be retried)

5. **Retrieval** (`src/retrieval/`):
   - `prepareRetrieval.ts`: splits files into "normally parsed" (handed to LM Studio's native `files.retrieve`) vs "custom parsed" (OCR/PPTX/DOCX content, scored manually), merges both result sets, filters by affinity threshold, sorts by score, slices to the retrieval limit, and calls `ctl.addCitations`
   - `embedCustomParsedFiles.ts`: chunks and embeds custom-parsed file content with the Nomic embedding model, caching the computed chunk embeddings back onto the same `globalCache` entry so they're computed once per file per process lifetime
   - `chunkText.ts`: fixed-size sliding-window chunker (1000 chars, 150 overlap)
   - `similarity.ts`: cosine similarity between two embedding vectors

6. **Entry Point** (`src/index.ts`):
   - Registers `configSchematics` and the `preprocess` prompt preprocessor with LM Studio

### Project Structure

```
context-aware-rag/
├── src/
│   ├── index.ts                      # Plugin entry point
│   ├── config.ts                     # Plugin configuration schema
│   ├── promptPreprocessor.ts         # Main preprocessing entry point
│   ├── context/
│   │   └── measureContext.ts         # Context window token measurement
│   ├── strategy/
│   │   ├── chooseStrategy.ts         # inject-full-content vs retrieval decision
│   │   └── injectFullContent.ts      # Full-text injection
│   ├── parser/
│   │   ├── parserTypes.ts            # Parser interface + result/context types
│   │   ├── parserChain.ts            # Ordered fallback chain runner
│   │   ├── parserIndex.ts            # Default chain wiring
│   │   ├── lmstudioParser.ts         # Native LM Studio parser wrapper
│   │   ├── ocrPdfParser.ts           # MuPDF render + Tesseract OCR fallback
│   │   ├── pptxParser.ts             # PPTX slide/notes text extraction
│   │   ├── docxParser.ts             # DOCX paragraph/header/footer extraction
│   │   └── parseFile.ts              # Cache-aware parse entry point
│   ├── retrieval/
│   │   ├── prepareRetrieval.ts       # Native + custom retrieval, merge, citations
│   │   ├── embedCustomParsedFiles.ts # Chunk + embed OCR/PPTX/DOCX content
│   │   ├── chunkText.ts              # Sliding-window text chunker
│   │   └── similarity.ts             # Cosine similarity
│   └── types/
│       └── types.ts                  # Shared types (ParsedFile, ScoredEntry, ...)
├── scripts/
│   └── fix-install-assets.js         # Copies eng.traineddata into the installed plugin
├── test_cases/
│   ├── TEST_PLAN.md                  # Manual strategy-selection test plan
│   └── test_documents/               # Sample files used by the test plan
├── eng.traineddata                   # Tesseract English language pack (git-ignored, shipped locally)
├── manifest.json                     # Plugin manifest
├── package.json                      # Dependencies
├── tsconfig.json                     # TypeScript config
└── README.md                         # This file
```

## Testing

There's no automated test suite (no `test` script) — verification is manual, driven by `test_cases/TEST_PLAN.md` against the sample files in `test_cases/test_documents/`. The plan covers:

- Full-content injection when files comfortably fit the context window
- Retrieval triggering once token count exceeds the occupancy threshold
- Strategy flipping mid-conversation as context fills up with history
- Follow-up messages (no new attachment) correctly routing history files through retrieval instead of re-injecting them
- The no-op path when no files are present anywhere in the chat

To exercise the OCR/PPTX/DOCX parsers directly, attach the corresponding sample file (`OCR Korea AI Plan.pdf`, `SNIP Overview.pptx`, `Plugin Development.docx`) from `test_cases/test_documents/` in a real chat and watch the status messages LM Studio displays while the plugin runs.

## Troubleshooting

### OCR not finding text / running against the network

- `eng.traineddata` should already exist at the project root; run `npm run install-plugin` (not just `npm run dev`) so it gets copied into `~/.lmstudio/extensions/plugins/saic/context-aware-rag/`. Without it, Tesseract falls back to downloading the language pack from the network on first OCR run.
- OCR only runs when the native LM Studio parser's output is under ~50 characters — a PDF with any real embedded text will never reach the OCR stage even if `enableOcrFallback` is on.
- OCR is capped at the first 50 pages of a PDF; content beyond that is silently dropped.
- OCR is English-only (`createWorker("eng")`); scanned non-English PDFs will produce garbled or empty text rather than failing cleanly.

### No text extracted from PPTX/DOCX

- Both parsers are text-only: image-only slides or documents that are just embedded images (no `<a:t>`/`<w:t>` runs) yield no extracted text. Images/diagrams are never OCR'd for these formats — only flat/scanned PDFs get the OCR fallback.
- If the file has no local path available (e.g. some remote/attachment sources), the parser fails with `no-local-path` and falls through to the next parser in the chain (or ultimately to LM Studio's native parser result, if any).

### Stale or duplicated content across turns

- The cache is keyed by resolved file path (or `file.name` if no path is available) — two different files that resolve to the same path or name will collide in the cache.
- The cache is process-lifetime only: it doesn't persist across LM Studio restarts, and there's no manual invalidation if a file changes on disk after being parsed once. Restart the `lms dev` session (or the LM Studio app) to force a clean re-parse.

### Wrong strategy chosen (retrieval when injection was expected, or vice versa)

- The 70%-of-remaining-context threshold is fixed in `chooseStrategy.ts`, not configurable via plugin settings.
- Strategy is recalculated fresh on every turn from the *current* context occupancy — a file that got full injection early in a chat can switch to retrieval later as history fills up the window.

## Limitations

- **OCR is English-only** — the Tesseract worker is hardcoded to the `"eng"` language pack; scanned non-English PDFs will produce garbled or empty text rather than failing cleanly.
- **OCR page cap** — only the first 50 pages of a scanned PDF are processed; content beyond that is silently dropped.
- **Only PDF, PPTX, and DOCX have dedicated parsers** — every other file type (`.csv`, `.md`, etc.) depends entirely on whatever LM Studio's native `files.parseDocument` supports; there's no custom fallback for those.
- **PPTX/DOCX are text-only** — image-only slides or documents that are just embedded images (no `<a:t>`/`<w:t>` runs) yield no extracted text; images/diagrams are never OCR'd for these formats.
- **No corrupt-file recovery** — a truncated or malformed file simply fails out of the parser chain (empty content returned); there's no partial-recovery attempt.
- **Cache is path-keyed, not content-hashed** — two different files that happen to resolve to the same path (or fall back to the same `file.name` when no path is available) will collide in the cache.
- **Cache is process-lifetime only** — no persistence across LM Studio restarts, and no manual invalidation if a file changes on disk after being parsed once.
- **Single hardcoded embedding model** — retrieval always uses `nomic-ai/nomic-embed-text-v1.5-GGUF`; it isn't configurable.
- **No de-duplication across strategies** — if the same file is later re-attached, both the strategy chooser and retrieval path re-parse (though cached) and re-score from scratch each turn.
- **No `typescript` devDependency** — `node_modules/.bin/tsc` may be present from a hoisted/shared install, but this project doesn't declare `typescript` itself, so a clean `npm install` here won't give you a working `tsc` unless you add it.

## Development

### Contributing

This plugin is based on the LM Studio plugin SDK. For more information:

- [lmstudio-js GitHub](https://github.com/lmstudio-ai/lmstudio-js)
- [Documentation](https://lmstudio.ai/docs)
- [Discord](https://discord.gg/6Q7Xn6MRVS)

## License

ISC

## Acknowledgments

- Built using the LM Studio SDK
- OCR powered by Tesseract.js, with MuPDF used to rasterize PDF pages for it
- PPTX/DOCX text extraction via JSZip (unzips the Office Open XML container and parses slide/document XML directly)
- Retrieval embeddings via the Nomic embedding model (`nomic-ai/nomic-embed-text-v1.5-GGUF`)
