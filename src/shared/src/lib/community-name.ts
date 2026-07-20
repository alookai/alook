import { MAX_PROFILE_NAME_LENGTH } from "../constants/community";

// A mentionable community name (user display name or bot name) is serialized
// into message text as `@Name#dddd`. Because the display parser treats the
// trailing `#dddd` as an unambiguous terminator and everything before it as the
// name (spaces included), the name itself must never contain `#`, `@`, or a
// line break — any of those would let a name masquerade as (or break) the tag
// grammar and resolve a mention to the wrong user. See
// plans/mandatory-mention-discriminator.md.
//
// The forbidden set: `#`, `@`, and any C0/C1 control char (covers `\n`, `\r`,
// `\t`, DEL). Everything else — spaces, unicode letters, hyphens, underscores —
// stays allowed.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARS = /[#@\x00-\x1f\x7f-\x9f]/;

export type CommunityNameValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate a mentionable community name for a surface that CAN reject (a user
 * profile PATCH, a bot create/rename). Trims first, then enforces non-empty,
 * length, and the forbidden-char rule. Returns a structured result carrying a
 * human-readable reason for the API error message.
 */
export function validateCommunityName(name: string): CommunityNameValidation {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: "name cannot be empty" };
  if (trimmed.length > MAX_PROFILE_NAME_LENGTH) {
    return { ok: false, reason: `name must be ≤ ${MAX_PROFILE_NAME_LENGTH} characters` };
  }
  if (FORBIDDEN_NAME_CHARS.test(trimmed)) {
    return { ok: false, reason: "name cannot contain #, @, or line breaks" };
  }
  return { ok: true };
}

/**
 * Sanitize a name for a surface that CANNOT reject — the auth signup/update
 * hooks, where `user.name` arrives from an OAuth provider or an email
 * local-part and a 400 would fail the whole flow. Strips the forbidden chars,
 * collapses the resulting whitespace, and clamps to the max length. Never
 * throws; a fully-stripped name falls back to a placeholder so the column
 * stays non-empty.
 */
export function sanitizeCommunityName(name: string): string {
  const stripped = name
    .replace(/[#@]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROFILE_NAME_LENGTH)
    .trim();
  return stripped || "user";
}
