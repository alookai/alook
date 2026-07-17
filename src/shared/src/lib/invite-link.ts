// Extracts a bare invite token from either a full `.../c/invite/<token>`
// URL (with or without an origin) or a bare token. Kept as an independent copy
// of `INVITE_URL_RE` in `src/web/src/components/community/message-markdown.tsx`
// (that file is UI-only, rendering invite links inline in message bodies, and
// is out of scope for this CLI feature) — a future drift between the two is at
// least discoverable via this cross-reference comment, not silently divergent.
const INVITE_URL_RE = /(?:https?:\/\/[^\s/]+)?\/c\/invite\/([A-Za-z0-9_-]{6,64})/;
const BARE_TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Extract the bare invite token from `input`, which may be a full URL, a
 * path-only URL (no origin), or a bare token. Returns `null` when no valid
 * token can be found — callers surface this as a descriptive CLI error.
 */
export function parseInviteToken(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const urlMatch = INVITE_URL_RE.exec(trimmed);
  if (urlMatch) return urlMatch[1]!;

  return BARE_TOKEN_RE.test(trimmed) ? trimmed : null;
}
