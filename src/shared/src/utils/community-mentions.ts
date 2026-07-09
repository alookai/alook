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
 *
 * When a candidate carries a `discriminator`, an exact `@Name#0042` match is
 * tried FIRST at each `@` site (so a channel with two "Alex"es can be
 * disambiguated), falling back to the existing longest-bare-name match when
 * no `#0042` suffix is present or it doesn't match anyone.
 */

import { formatHandle } from "../lib/discriminator";

export interface MentionCandidate {
  userId: string;
  name: string;
  /** 4-digit tag (`computeDiscriminator`). Enables exact `@Name#0042` matching. */
  discriminator?: string;
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

  // Exact `@Name#0042` handles, tried FIRST at each `@` site — longest-handle
  // first (mirrors the bare-name ordering). Built from ALL candidates (not
  // the de-duped-by-name map above) since a handle is already unambiguous
  // per-candidate; de-duping by name would arbitrarily drop one of the two
  // "Alex"es a handle exists specifically to disambiguate.
  const handled = candidates
    .filter((c): c is MentionCandidate & { discriminator: string } => !!c.name && !!c.discriminator)
    .map((c) => ({ candidate: c, handle: formatHandle(c.name, c.discriminator).toLowerCase() }))
    .sort((a, b) => b.handle.length - a.handle.length);

  if (sorted.length === 0 && handled.length === 0) return [];

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
    let matchedLen = 0;
    for (const { candidate, handle } of handled) {
      const slice = lower.slice(at + 1, at + 1 + handle.length);
      if (slice !== handle) continue;
      const after = content[at + 1 + handle.length];
      if (!isBoundaryChar(after)) continue;
      matched = candidate;
      matchedLen = handle.length;
      break;
    }
    if (!matched) {
      for (const cand of sorted) {
        const nameLen = cand.name.length;
        const slice = lower.slice(at + 1, at + 1 + nameLen);
        if (slice !== cand.name.toLowerCase()) continue;
        const after = content[at + 1 + nameLen];
        if (!isBoundaryChar(after)) continue;
        matched = cand;
        matchedLen = nameLen;
        break;
      }
    }
    if (matched) {
      found.add(matched.userId);
      i = at + 1 + matchedLen;
    } else {
      i = at + 1;
    }
  }
  return [...found];
}
