/**
 * Normalize a server/channel display name so it can round-trip through the
 * `/server/channel` ref grammar (`community-cli-contract.ts`'s `ChannelRef`)
 * and `CHANNEL_REF_REGEX` (`message-markdown.tsx`) as a single, unambiguous
 * path segment. This is NOT the classic ASCII `lowercase-and-hyphenate`
 * slugify — case and non-Latin scripts (Chinese, Japanese, emoji, ...) are
 * preserved untouched. Only whitespace (collapsed to a single `-`) and the
 * two grammar-reserved characters `/`/`#` (stripped outright, no hyphen
 * substitution) are normalized away.
 *
 * Callers must treat an empty-string result as "nothing left after
 * normalizing" (e.g. input was all whitespace/`/`/`#`) and reject it the
 * same way an empty name is rejected today.
 */
export function slugify(name: string): string {
  return name
    .replace(/[/#]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}
