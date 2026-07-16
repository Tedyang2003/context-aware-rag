import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import type { Parser } from "./parserTypes";

function cleanText(text: string): string {
    return text.replace(/\s+/g, " ").replace(/\n+/g, "\n").trim();
}

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/**
 * Extracts every <w:t> run from a document/header/footer XML string, in
 * document order. <w:t> is WordprocessingML's text run — same role as
 * <a:t> in DrawingML/PPTX. Table cell text lives in nested <w:p> elements
 * so no special-casing is needed for tables.
 */
function extractTextRuns(xml: string): string[] {
    const runs: string[] = [];
    const regex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
        const decoded = decodeXmlEntities(match[1]);
        if (decoded.length > 0) runs.push(decoded);
    }
    return runs;
}

/**
 * Groups consecutive <w:t> runs that belong to the same paragraph (<w:p>) so
 * words aren't mashed together across paragraph breaks. Word often splits a
 * sentence across multiple runs (e.g. for mixed formatting), so runs within
 * a paragraph are joined directly, with a newline between paragraphs.
 */
function extractParagraphs(xml: string): string[] {
    const paragraphs: string[] = [];
    const paraRegex = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
    let paraMatch: RegExpExecArray | null;
    while ((paraMatch = paraRegex.exec(xml)) !== null) {
        const runs = extractTextRuns(paraMatch[1]);
        const joined = runs.join("").trim();
        if (joined.length > 0) paragraphs.push(joined);
    }
    return paragraphs;
}

async function extractDocxText(
    fileBuffer: Buffer,
    options: { includeHeadersFooters: boolean },
): Promise<{ success: true; text: string } | { success: false; reason: string }> {
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(fileBuffer);
    } catch (error) {
        return { success: false, reason: `invalid-docx: ${error instanceof Error ? error.message : String(error)}` };
    }

    const documentFile = zip.files["word/document.xml"];
    if (!documentFile) {
        return { success: false, reason: "no-document-found" };
    }

    const parts: string[] = [];

    if (options.includeHeadersFooters) {
        const headerPaths = Object.keys(zip.files)
            .filter(p => /^word\/header\d+\.xml$/.test(p))
            .sort();
        for (const headerPath of headerPaths) {
            const xml = await zip.files[headerPath].async("text");
            const paragraphs = extractParagraphs(xml);
            if (paragraphs.length > 0) {
                parts.push(`[Header]`);
                parts.push(...paragraphs);
            }
        }
    }

    const documentXml = await documentFile.async("text");
    const bodyParagraphs = extractParagraphs(documentXml);
    parts.push(...bodyParagraphs);

    if (options.includeHeadersFooters) {
        const footerPaths = Object.keys(zip.files)
            .filter(p => /^word\/footer\d+\.xml$/.test(p))
            .sort();
        for (const footerPath of footerPaths) {
            const xml = await zip.files[footerPath].async("text");
            const paragraphs = extractParagraphs(xml);
            if (paragraphs.length > 0) {
                parts.push(`[Footer]`);
                parts.push(...paragraphs);
            }
        }
    }

    const fullText = cleanText(parts.join("\n"));
    if (fullText.length === 0) {
        return { success: false, reason: "no-text-found" };
    }
    return { success: true, text: fullText };
}

export const docxTextParser: Parser = {
    name: "docx-text",
    canParse: (file) => file.name.toLowerCase().endsWith(".docx"),
    async parse(file, ctx) {
        const status = ctx.ctl.createStatus({
            status: "loading",
            text: `Reading text from ${file.name}...`,
        });

        let fileBuffer: Buffer;
        try {
            fileBuffer = await readFile(ctx.filePath);
        } catch {
            status.setState({ status: "canceled", text: `Cannot read ${file.name}: no local file path available` });
            return { success: false, reason: "no-local-path" };
        }

        const result = await extractDocxText(fileBuffer, { includeHeadersFooters: true });

        if (result.success) {
            status.setState({ status: "done", text: `Extracted text from ${file.name}` });
            return { success: true, content: result.text, parserName: "docx-text", isCustomExtraction: true };
        }
        status.setState({ status: "canceled", text: `No text found in ${file.name}: ${result.reason}` });
        return { success: false, reason: result.reason };
    },
};
