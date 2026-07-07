/**
 * Resolves `@Name` tokens in a community message body to userIds, given a
 * roster of candidate members. Matching is case-insensitive, longest-match
 * first (so `@John Doe` wins over `@John` when both exist).
 *
 * A match must:
 *  - be preceded by start-of-string or a non-identifier character
 *  - be followed by end-of-string or a non-identifier character
 *
 * Identifier characters are `[A-Za-z0-9_]`, so a name ending or starting in
 * those plus the next-char rule covers normal punctuation, spaces, and
 * newlines as boundaries. Names containing whitespace are supported.
 */

export interface MentionCandidate {
  userId: string;
  name: string;
}

/**
 * The roster-wide mention triggers. Order matters — when both `@everyone` and
 * `@here` appear in the same message, `everyone` wins (broader scope wins).
 */
export const MENTION_TYPES = ["everyone", "here"] as const;
export type MentionType = (typeof MENTION_TYPES)[number];

export function isMentionType(value: unknown): value is MentionType {
  return value === "everyone" || value === "here";
}

const ID_CHAR_RE = /[A-Za-z0-9_]/;

function isBoundaryChar(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return !ID_CHAR_RE.test(ch);
}

export function extractMentionedUserIds(
  content: string,
  candidates: MentionCandidate[]
): string[] {
  if (!content) return [];
  // De-dupe by name, prefer the first occurrence. Then sort by length desc so
  // we try the most specific name first at each `@` site.
  const byName = new Map<string, MentionCandidate>();
  for (const c of candidates) {
    if (!c.name) continue;
    const key = c.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, c);
  }
  const sorted = [...byName.values()].sort((a, b) => b.name.length - a.name.length);
  if (sorted.length === 0) return [];

  const lower = content.toLowerCase();
  const found = new Set<string>();

  let i = 0;
  while (i < content.length) {
    const at = content.indexOf("@", i);
    if (at === -1) break;
    // The character before "@" must be a boundary (or start of string).
    if (at > 0 && !isBoundaryChar(content[at - 1])) {
      i = at + 1;
      continue;
    }
    let matched: MentionCandidate | undefined;
    for (const cand of sorted) {
      const nameLen = cand.name.length;
      const slice = lower.slice(at + 1, at + 1 + nameLen);
      if (slice !== cand.name.toLowerCase()) continue;
      const after = content[at + 1 + nameLen];
      if (!isBoundaryChar(after)) continue;
      matched = cand;
      break;
    }
    if (matched) {
      found.add(matched.userId);
      i = at + 1 + matched.name.length;
    } else {
      i = at + 1;
    }
  }
  return [...found];
}
