/**
 * Normalize a server/channel display name so it round-trips through
 * `CHANNEL_REF_REGEX` (`message-markdown.tsx`) as a single, unambiguous
 * token. This is NOT the classic ASCII `lowercase-and-hyphenate`
 * slugify — case and non-Latin scripts (Chinese, Japanese, emoji, ...) are
 * preserved untouched. Only whitespace (collapsed to a single `-`) and the
 * two grammar-reserved characters `/`/`#` (stripped outright, no hyphen
 * substitution) are normalized away.
 *
 * Examples: `"My Home"` -> `"My-Home"`, `"总部 🎉"` -> `"总部-🎉"`,
 * `"a/b#c"` -> `"abc"`, `"general"` -> `"general"` (unchanged).
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
