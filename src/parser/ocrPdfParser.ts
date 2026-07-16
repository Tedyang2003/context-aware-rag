import { readFile } from "node:fs/promises";
import { createWorker } from "tesseract.js";
import type { Parser } from "./parserTypes";
import { configSchematics } from "../config";

let cacheMupdf: typeof import("mupdf") | null = null;

// Load Mupdf dynamically to avoid bundling it in the main bundle, as it is a large dependency
async function getMupdf() {
    if (!cacheMupdf) {
        cacheMupdf = await import("mupdf");
    }
    return cacheMupdf;
}

export const MIN_TEXT_LENGTH = 50;
const OCR_MAX_PAGES = 50;

// Squash all consecutive white spaces into a single space
// Squash all consecutive new lines into a single new line
function cleanText(text: string): string {
    return text.replace(/\s+/g, " ").replace(/\n+/g, "\n").trim();
}

async function runOcr(
    fileBuffer: Buffer,
    fileName: string,
    signal?: AbortSignal,
    onProgress?: (page: number, maxPages: number, chars: number) => void,
): Promise<{ success: true; text: string } | { success: false; reason: string }> {
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    try {
        // Load the MuPDF library and open the PDF document
        const mupdf = await getMupdf();
        const doc = mupdf.Document.openDocument(fileBuffer, "application/pdf");
        const maxPages = Math.min(doc.countPages(), OCR_MAX_PAGES);

        // English OCR worker
        worker = await createWorker("eng");

        const textParts: string[] = [];
        let renderErrors = 0;

        // For each page, render it to an image and run OCR
        for (let pageNum = 0; pageNum < maxPages; pageNum++) {
            if (signal?.aborted) {
                console.log(`[OCR] Aborted OCR for ${fileName} at page ${pageNum + 1}/${maxPages}`);
                break;
            }

            try {
                const page = doc.loadPage(pageNum);

                // Scale the page for better OCR accuracy
                const matrix = mupdf.Matrix.scale(2, 2);

                // Convert the page to an image (pixmap)
                const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);

                // Run OCR text recognition
                const { data: { text } } = await worker.recognize(Buffer.from(pixmap.asPNG()));

                // Clean and store the text (only if non-empty)
                const cleaned = cleanText(text || "");
                if (cleaned.length > 0) {
                    textParts.push(cleaned);
                }

                // Progress callback — reports cumulative chars extracted so far
                onProgress?.(pageNum + 1, maxPages, textParts.join("\n").length);
            } catch (pageError) {
                renderErrors++;
                console.error(`[OCR] Error on page ${pageNum + 1} of ${fileName}:`, pageError);
            }
        }

        await worker.terminate();
        worker = null;

        if (renderErrors > 0) {
            console.warn(`[OCR] ${fileName} had ${renderErrors}/${maxPages} page errors`);
        }

        // If the text is substantial enough, return it; otherwise indicate an empty result
        const fullText = cleanText(textParts.join("\n"));
        if (fullText.length >= MIN_TEXT_LENGTH) {
            return { success: true, text: fullText };
        }
        return { success: false, reason: "ocr-empty" };
    } catch (error) {
        if (worker) await worker.terminate();
        return { success: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

export const ocrPdfParser: Parser = {
    name: "ocr-pdf",
    canParse: (file, ctx) => {
        const enabled = ctx.ctl.getPluginConfig(configSchematics).get("enableOcrFallback");
        return enabled && file.name.toLowerCase().endsWith(".pdf");
    },
    // only run OCR if the previous parser's text was too short
    shouldSkip: (previous) =>
        previous?.success === true && previous.content.trim().length >= MIN_TEXT_LENGTH,
    async parse(file, ctx) {
        const status = ctx.ctl.createStatus({
            status: "loading",
            text: `${file.name} looks like a scanned/flat PDF — running OCR...`,
        });

        let fileBuffer: Buffer;
        try {
            fileBuffer = await readFile(ctx.filePath);
        } catch {
            status.setState({ status: "canceled", text: `Cannot OCR ${file.name}: no local file path available` });
            return { success: false, reason: "no-local-path" };
        }

        const result = await runOcr(fileBuffer, file.name, ctx.ctl.abortSignal, (page, maxPages, chars) => {
            status.setState({ status: "loading", text: `OCR ${file.name}: page ${page}/${maxPages} (${chars} chars so far)` });
        });

        if (result.success) {
            status.setState({ status: "done", text: `OCR recovered text from ${file.name}` });
            return { success: true, content: result.text, parserName: "ocr-pdf", isCustomExtraction: true};
        }
        status.setState({ status: "canceled", text: `OCR found no text in ${file.name}` });
        return { success: false, reason: result.reason };
    },
};