// Plain-text paste → ProseMirror DOM, preserving BOTH structure levels.
//
// ProseMirror's default clipboard text parser splits on `/(?:\r\n?|\n)+/` —
// one-OR-MORE newlines collapse to a single paragraph boundary, so a blank
// line (`\n\n`, a real paragraph break) and a single `\n` (an in-paragraph
// line break) become indistinguishable the moment text is pasted. Pasting an
// agent's multi-paragraph answer therefore flattens every paragraph gap.
//
// This builds the DOM the parser needs from the two levels the source text
// actually encodes, matching markdown's block model exactly:
//   - `\n\n+` (one blank line or more) → a new <p> (paragraph break)
//   - single `\n` inside a block        → a <br> (hard line break)
// Paired with `getText({ blockSeparator: "\n\n" })` on send and `remark-breaks`
// on render, the round-trip is lossless: paste → serialize → render all agree.
//
// Extracted as a pure DOM builder (no ProseMirror imports) so it can be unit
// tested with jsdom's `document`; the composer wraps it in a
// `clipboardTextParser` that hands the DOM to ProseMirror's own
// `DOMParser.parseSlice` (which computes slice open depths correctly — never
// hand-rolled here).

// Split on 2+ newlines (allowing \r\n / \r), trimming a single leading/trailing
// blank-line run so a copied block with surrounding whitespace doesn't yield
// empty leading/trailing paragraphs.
const PARAGRAPH_SPLIT = /(?:\r\n?|\n){2,}/

export function splitPlainTextToBlocks(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "")
  if (normalized === "") return []
  return normalized.split(PARAGRAPH_SPLIT)
}

/**
 * Pure structural view of pasted text: an array of blocks (paragraphs), each
 * block an array of lines (hard breaks between them). No DOM — the unit-
 * testable core of the paste transform.
 *   "a\nb\n\nc" → [["a", "b"], ["c"]]
 */
export function planPastedBlocks(text: string): string[][] {
  return splitPlainTextToBlocks(text).map((block) => block.split("\n"))
}

/**
 * Build a `<div>` of `<p>` blocks (single `\n` → `<br>`) from pasted plain
 * text, using the provided `doc`. Returns a DIV whose children ProseMirror's
 * `DOMParser.parseSlice` can consume.
 */
export function buildPasteDom(text: string, doc: Document): HTMLDivElement {
  const wrap = doc.createElement("div")
  for (const lines of planPastedBlocks(text)) {
    const p = doc.createElement("p")
    lines.forEach((line, i) => {
      if (i > 0) p.appendChild(doc.createElement("br"))
      if (line) p.appendChild(doc.createTextNode(line))
    })
    wrap.appendChild(p)
  }
  return wrap
}
