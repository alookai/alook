/**
 * Resolves `@Name#0042` mention handles in a community message body to userIds,
 * given a roster of candidate members. Only fully-tagged handles resolve — a
 * hand-typed bare `@Name` (no discriminator) is NOT a mention, matching the
 * display parser in `chat-syntax-plugin.ts` so the pill and the notification
 * fan-out never disagree (see plans/mandatory-mention-discriminator.md).
 *
 * A handle match must:
 *  - be preceded by start-of-string or a non-identifier character
 *  - be followed by end-of-string or a non-identifier character
 *
 * Handles are tried longest-first at each `@` site (so a longer name wins).
 * The handle string (`name#dddd`) is a raw substring compare, not a charset
 * regex, so names containing spaces resolve correctly (`@John Doe#0042`).
 * Identifier characters for the boundary check are `\p{L}\p{N}_-`
 * (Unicode-aware — `Member.name` is a free Unicode string).
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

const ID_CHAR_RE = /[\p{L}\p{N}_-]/u;

function isBoundaryChar(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return !ID_CHAR_RE.test(ch);
}

export function extractMentionedUserIds(
  content: string,
  candidates: MentionCandidate[]
): string[] {
  if (!content) return [];

  // Only exact `@Name#0042` handles resolve — the bare-name fallback was
  // removed so the send side agrees with the display parser: a hand-typed bare
  // `@Alice` is NOT a mention on either surface (see
  // plans/mandatory-mention-discriminator.md). Handles are tried longest-first
  // and built from ALL candidates (a handle is already unambiguous per user;
  // two same-name "Alex"es both keep their distinct handle). A candidate with
  // no discriminator can't be mentioned and is dropped here.
  const handled = candidates
    .filter((c): c is MentionCandidate & { discriminator: string } => !!c.name && !!c.discriminator)
    .map((c) => ({ candidate: c, handle: formatHandle(c.name, c.discriminator).toLowerCase() }))
    .sort((a, b) => b.handle.length - a.handle.length);

  if (handled.length === 0) return [];

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
    if (matched) {
      found.add(matched.userId);
      i = at + 1 + matchedLen;
    } else {
      i = at + 1;
    }
  }
  return [...found];
}
