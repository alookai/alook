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
 * The EMAIL is the machine-readable attribution key and MUST be unique per
 * agent. The discriminator alone is not enough (it is FNV-1a(user.id) mod
 * 10000 — a 4-digit space with expected collisions), and the display-name slug
 * is lossy ("Bot One"/"Bot-One" → "bot-one"). Uniqueness therefore comes from
 * `agentId` (a nanoid): a slice of it suffixes the local-part so two distinct
 * agents can never share an email even when name and discriminator collide.
 * The NAME field stays the human `Name#Disc` — display only, so cosmetic
 * ambiguity there is acceptable.
 */

const GIT_IDENTITY_DOMAIN = "alook.ai";
const SHORT_ID_LEN = 8;

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
  agentId?: string;
}

/**
 * Build the four `GIT_*` env vars for one agent. Pure — no I/O. Always returns
 * a valid, non-empty identity; falls back to a generic one when name is
 * missing.
 */
export function buildGitIdentityEnv(input: GitIdentityInput): Record<string, string> {
  const { agentName, discriminator, agentId } = input;

  const cleanName = agentName ? sanitizeGitName(agentName) : "";
  const displayName = cleanName
    ? discriminator
      ? `${cleanName}#${discriminator}`
      : cleanName
    : FALLBACK_NAME;

  // Local-part fragments in readability order: name slug, discriminator, and a
  // short slice of the (globally unique) agentId. The agentId slice is what
  // guarantees per-agent uniqueness; the rest is for human readability.
  const shortId = agentId ? asciiSlug(agentId).slice(0, SHORT_ID_LEN) : "";
  const nameSlug = cleanName ? asciiSlug(cleanName) : "";
  const localPart =
    [nameSlug, discriminator, shortId].filter(Boolean).join("-") || FALLBACK_LOCAL_PART;
  const email = `${localPart}@${GIT_IDENTITY_DOMAIN}`;

  return {
    GIT_AUTHOR_NAME: displayName,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: displayName,
    GIT_COMMITTER_EMAIL: email,
  };
}
