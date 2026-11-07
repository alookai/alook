import { messagePreviewText, type MessagePreviewInput } from "../lib/message-preview";

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
