/**
 * The chat wire format is a plain string and must stay byte-identical to what
 * the old textarea sent. But `@tiptap/markdown`'s serializer HTML-entity-encodes
 * the three HTML-significant characters in plain text — `<`→`&lt;`, `>`→`&gt;`,
 * `&`→`&amp;` — so `getMarkdown()` of "x < 5 && y > 3" returns
 * "x &lt; 5 &amp;&amp; y &gt; 3". Markdown punctuation (`*` `_` `` ` `` `#`) is
 * left literal, which is what we want; only these HTML entities leak in.
 *
 * We decode exactly those three back so the outgoing content matches the typed
 * text. `&amp;` is decoded LAST so a literal "&lt;" the user typed (which the
 * serializer emits as "&amp;lt;") round-trips to "&lt;", not "<".
 */
export function decodeChatEntities(markdown: string): string {
  return markdown
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
