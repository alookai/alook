/**
 * Treat editor output as empty when the HTML string, stripped of whitespace
 * and single-paragraph-with-br scaffolding, has no visible content.
 *
 * Matches ProseMirror/tiptap's "empty editor" output: `""`, `<p></p>`,
 * `<p><br></p>`, `<p>\n</p>`, and surrounding whitespace variants.
 */
export function isEmptyHtml(html: string | null | undefined): boolean {
  if (html == null) return true;
  const trimmed = html.trim();
  if (trimmed === "") return true;

  const match = /^<p>([\s\S]*?)<\/p>$/i.exec(trimmed);
  if (!match) return false;
  const inner = match[1]!
    .replace(/<br\s*\/?\s*>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .trim();
  return inner === "";
}
