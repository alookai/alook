/**
 * Per-agent git identity for the spawn environment.
 *
 * The daemon injects `GIT_AUTHOR_*` / `GIT_COMMITTER_*` into each agent's child
 * process so a commit is attributed to the agent that made it. This is
 * ENV-ONLY: it never writes `~/.gitconfig` or any repo's `.git/config`, so the
 * human owner's own git identity is never touched — the injection is effective
 * only inside the agent's session.
 *
 * Both author and committer are set: git falls back committer → machine
 * identity otherwise, which would leave attribution half-wrong.
 *
 * NAME is the plain display name (`Claudette`) and EMAIL is
 * `<name-slug>.<discriminator>@alook.ai` (`claudette.9873@alook.ai`) — kept
 * clean/readable per owner preference. The discriminator is FNV-1a(user.id)
 * mod 10000, so two agents that share a name AND a discriminator would produce
 * the same identity; that collision is accepted (name#disc is already the
 * app's display-unique key, and the odds are low). If per-agent uniqueness
 * ever needs to be guaranteed on the git side again, reintroduce an agentId
 * suffix in the local-part.
 */

const GIT_IDENTITY_DOMAIN = "alook.ai";

/** Generic identity when an agent's name/handle is unavailable (degraded spawn). */
const FALLBACK_NAME = "Alook Agent";
const FALLBACK_LOCAL_PART = "alook-agent";

/**
 * Strip characters illegal in a git author/committer NAME. The name is a single
 * header line, so CR/LF and other control chars must go (they could otherwise
 * inject/split commit metadata). UTF-8 (CJK, emoji, …) is legal in a git name
 * and is preserved. Whitespace is collapsed and trimmed. Returns "" if nothing
 * legible remains.
 */
function sanitizeGitName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Reduce a string to a safe email local-part fragment: lowercase ASCII
 * alphanumerics, every other run collapsed to a single "-", trimmed. Returns ""
 * when nothing ASCII-alphanumeric survives (e.g. an all-CJK/emoji name) — the
 * caller drops the empty fragment rather than emit a stray "-".
 */
function asciiSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface GitIdentityInput {
  agentName?: string;
  discriminator?: string;
}

/**
 * Build the four `GIT_*` env vars for one agent. Pure — no I/O. Always returns
 * a valid, non-empty identity; falls back to a generic one when name is
 * missing.
 *
 * Name = the plain display name (`Claudette`). Email =
 * `<name-slug>.<discriminator>@alook.ai` (`claudette.9873@alook.ai`); if the
 * name has no ASCII-alphanumeric characters (all CJK/emoji) the local-part is
 * just the discriminator (`9873@alook.ai`), and if neither is available it
 * falls back to `alook-agent@alook.ai`.
 */
export function buildGitIdentityEnv(input: GitIdentityInput): Record<string, string> {
  const { agentName, discriminator } = input;

  const cleanName = agentName ? sanitizeGitName(agentName) : "";
  const displayName = cleanName || FALLBACK_NAME;

  // Email local-part: `<name-slug>.<discriminator>`, joined with "." and
  // dropping any empty fragment (all-CJK name → discriminator only; neither →
  // generic fallback).
  const nameSlug = cleanName ? asciiSlug(cleanName) : "";
  const localPart =
    [nameSlug, discriminator].filter(Boolean).join(".") || FALLBACK_LOCAL_PART;
  const email = `${localPart}@${GIT_IDENTITY_DOMAIN}`;

  return {
    GIT_AUTHOR_NAME: displayName,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: displayName,
    GIT_COMMITTER_EMAIL: email,
  };
}
