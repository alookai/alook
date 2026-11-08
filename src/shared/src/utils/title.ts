import { messagePreviewText, type MessagePreviewInput } from "../lib/message-preview";

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
