# Strategy Selection Test Plan

Testing `chooseContextInjectionStrategy` — does the plugin correctly pick
`inject-full-content` vs `retrieval` based on context window occupancy?

## 2.1 — Full-content injection
**Setup:** Small model context (e.g. 4K). Attach `Quarterly Performance Report.txt` alone, fresh chat.
**Expect:** File + prompt tokens fit under the 70%-of-remaining-context threshold → strategy = `inject-full-content`. Full file text gets wrapped into the prompt.

## 2.2 — Retrieval triggered by size
**Setup:** Same small context. Attach `OCR Korea AI Plan.pdf` (long OCR output).
**Expect:** Token count exceeds the threshold → strategy = `retrieval`. Citations returned instead of full text.

## 2.3 — Strategy flips as context fills up
**Setup:** Have a long back-and-forth conversation to raise `contextOccupiedPercent`, then attach a mid-size file that earlier in the same chat would have fit.
**Expect:** The same file that would get `inject-full-content` early in the conversation switches to `retrieval` once context is fuller (available token budget shrinks).

## 2.4 — Follow-up with no new attachment
**Setup:** Attach a file, ask a question about it. Then send a follow-up message with no new attachment.
**Expect:** Files from history (not the new message) get stripped and routed through `retrieval`, not full injection.

## 2.5 — No files at all
**Setup:** Plain text question, no attachments anywhere in the chat.
**Expect:** Plugin is a no-op — message passes through unchanged.
