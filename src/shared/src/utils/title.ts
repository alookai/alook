import { messagePreviewText, type MessagePreviewInput } from "../lib/message-preview";

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

export function stripInlineMarkup(raw: string): string {
  return messagePreviewText({ content: raw })
}

/**
 * Derive a clean thread name from a message body: strip markup, collapse
 * whitespace, keep the first `maxWords` words, cap at `maxChars`. Falls back to
 * `fallback` when the message yields no readable text.
 */
export function deriveThreadName(
  raw: string | MessagePreviewInput | null | undefined,
  fallback: string,
  maxWords = 6,
  maxChars = 60,
): string {
  const cleaned = messagePreviewText(typeof raw === "string" ? { content: raw } : raw ?? {})
    .replace(/\s+/g, " ")
    .trim();
  const name = cleaned.split(" ").filter(Boolean).slice(0, maxWords).join(" ").slice(0, maxChars).trim();
  return name || fallback;
}
