/**
 * Derive a conversation title from the first message body: collapse whitespace,
 * trim, and cap length at a word boundary when possible.
 *
 * Lifted from the user-send route so the agent-DM route can reuse the exact
 * same auto-title behaviour (both set a conversation's title on first message).
 */
export function truncateTitle(text: string, maxLen = 50): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLen) return trimmed;
  const cut = trimmed.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  const title = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return title + "...";
}

/**
 * Strip markdown / chat-syntax markup to plain readable text.
 *
 * A community thread's name is derived from the first words of the anchor
 * message body, which is raw markdown and may carry `||spoiler||`, `<spoiler>`
 * HTML tags, `**bold**`, `# headings`, `[label](url)` links, `@mention`
 * discriminators, and code spans. Left as-is those tokens render literally in
 * the Threads panel / breadcrumb and get re-interpreted once the name is
 * spliced into the `thread_created` system message body. This flattens them to
 * the human-readable text so the derived name is clean.
 *
 * Regex-based on purpose: `src/shared` has no markdown/AST dependency, and a
 * full remark pipeline is overkill for a six-word title.
 */
export function stripInlineMarkup(raw: string): string {
  return raw
    // Fenced code blocks → keep inner text, drop the ``` fences.
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, "$1")
    // Images ![alt](url) → alt text.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Links [label](url) / [label][ref] → label.
    .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    // HTML/XML-style tags (<spoiler>, </spoiler>, <br/>, …).
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    // `||spoiler||` → inner text.
    .replace(/\|\|([\s\S]*?)\|\|/g, "$1")
    // Inline code `code` → inner text.
    .replace(/`+([^`]*)`+/g, "$1")
    // Emphasis / strong / strike markers.
    .replace(/(\*\*|__|~~|\*|_)/g, "")
    // `@name#0042` discriminator → `@name`. Name-run allows spaces but must end
    // in a non-whitespace char, matching the display grammar in
    // `chat-syntax-plugin.ts` so a spaced-name mention (`@John Doe#0042`) strips
    // correctly and ordinary prose (`issue #0042`) does not.
    .replace(/(@[^@#\n\r]*[^@#\n\r\s])#\d{4}(?!\d)/gu, "$1")
    // Line-leading block markers: heading #, blockquote >, list bullets/numbers.
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "");
}

/**
 * Derive a clean thread name from a message body: strip markup, collapse
 * whitespace, keep the first `maxWords` words, cap at `maxChars`. Falls back to
 * `fallback` when the message yields no readable text.
 */
export function deriveThreadName(
  raw: string | null | undefined,
  fallback: string,
  maxWords = 6,
  maxChars = 60,
): string {
  const cleaned = stripInlineMarkup(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const name = cleaned.split(" ").filter(Boolean).slice(0, maxWords).join(" ").slice(0, maxChars).trim();
  return name || fallback;
}
