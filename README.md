## Custom RAG & OCR Preprocessor Plugin

A modified version of the RAG v1, preprocessor plugin for LM Studio, built for SAIC. 

This plugin intercepts incoming user messages with attachments, analyzes the available model context window, and dynamically determines the best strategy to inject or retrieve relevant document data—including an automated OCR fallback for flat or scanned PDFs.

### Key Features

#### Dynamic Context Engineering

Automatically measures your active LLM context window. Routes documents to either inject-full-content (if they easily fit) or retrieval (vector search chunking) based on a  customizable occupancy threshold.

#### Intelligent OCR Fallback

Scans text length of ingested PDFs. If a document appears to be a flat image or scanned file, it triggers a local OCR parsing pipeline using a custom buffer wrapper.

#### Persistent Module-Scoped Cache

Uses a global file-path-based memory map to cache extracted text across your entire chat session. Documents are parsed and OCR'd exactly once, eliminating redundant lag on subsequent conversation turns.

#### Hybrid Retrieval Engine

Combines native LM Studio document retrieval results with custom vector embeddings computed on OCR-recovered content using the Nomic embedding model.

### Current Functions

- **Strategy selection** (`chooseContextInjectionStrategy`) — measures the model's context window, occupied %, and total tokens across attached files + prompt. Picks `inject-full-content` if everything fits under a 70%-of-remaining-context budget, otherwise picks `retrieval`.
- **Full-content injection** (`prepareDocumentContextInjection`) — parses each file and inlines its full text directly into the prompt.
- **Retrieval** (`prepareRetrievalResultsContextInjection`) — runs native LM Studio file retrieval for normally-parsed files, and custom chunk + cosine-similarity scoring (via Nomic embeddings) for custom-parsed (OCR/pptx) files. Merges both, filters by affinity threshold, sorts by score, and slices to the configured retrieval limit.
- **Parser chain** (`parserChain` / `parserIndex`) — ordered fallback chain per file:
  1. Native LM Studio parser (catch-all for any file type it supports, e.g. txt, docx, pdf)
  2. OCR fallback (`.pdf` only) — triggers if the native parser's text is under 50 chars
  3. PPTX dedicated parser — extracts `<a:t>` text runs + speaker notes directly from slide XML
  4. DOCX dedicated parser — extracts `<w:t>` text runs (paragraphs + table cells) + headers/footers directly from document XML
- **Module-scoped cache** (`globalCache` in `parseFile.ts`) — keyed by resolved file path, holds parsed text and (lazily) computed chunk embeddings for the life of the plugin process. Failures are never cached, so a transient error can be retried.
- **Config options** — retrieval limit (1–10 chunks), retrieval affinity threshold (0.0–1.0), and an OCR fallback on/off toggle.
- **Image exclusion** — image attachments are filtered out of every code path; only non-image files are parsed, injected, or retrieved.



### Known Limitations

- **OCR is English-only** — the Tesseract worker is hardcoded to the `"eng"` language pack; scanned non-English PDFs will produce garbled or empty text rather than failing cleanly.
- **OCR page cap** — only the first 50 pages of a scanned PDF are processed; content beyond that is silently dropped.
- **Only PDF, PPTX, and DOCX have dedicated parsers** — every other file type (`.csv`, `.md`, etc.) depends entirely on whatever LM Studio's native `files.parseDocument` supports; there's no custom fallback for those.
- **PPTX/DOCX are text-only** — image-only slides or documents that are just embedded images (no `<a:t>`/`<w:t>` runs) yield no extracted text; images/diagrams are never OCR'd for these formats (only flat/scanned PDFs get the OCR fallback).
- **No corrupt-file recovery** — a truncated or malformed file simply fails out of the parser chain (empty content returned); there's no partial-recovery attempt.
- **Cache is path-keyed, not content-hashed** — two different files that happen to resolve to the same path (or fall back to the same `file.name` when no path is available) will collide in the cache.
- **Cache is process-lifetime only** — no persistence across LM Studio restarts, and no manual invalidation if a file changes on disk after being parsed once.
- **Single hardcoded embedding model** — retrieval always uses `nomic-ai/nomic-embed-text-v1.5-GGUF`; it isn't configurable.
- **No de-duplication across strategies** — if the same file is later re-attached, both the strategy chooser and retrieval path re-parse (though cached) and re-score from scratch each turn.

