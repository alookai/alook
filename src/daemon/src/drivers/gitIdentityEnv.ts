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

import { execFileSync } from "child_process";

const GIT_IDENTITY_DOMAIN = "alook.ai";

/** Timeout for the `git config` read of the host owner's identity. */
const HOST_GIT_READ_TIMEOUT_MS = 2000;

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

/** The host owner's own git identity, if their environment has one. */
export interface HostGitUser {
  name?: string;
  email?: string;
}

export interface GitIdentityInput {
  agentName?: string;
  discriminator?: string;
  /**
   * The host owner's own git identity (from `git config user.name/user.email`),
   * when present. When BOTH name and email are legible, the commit is
   * attributed two-ways: AUTHOR = the human owner (they wrote it), COMMITTER =
   * the agent (it applied it) — git's native author≠committer, both visible in
   * `git log --format=fuller` / on GitHub. When absent (owner never set a git
   * identity), falls back to the agent as both author and committer (today's
   * behavior). Read at the I/O boundary (`readHostGitIdentity`) and passed in;
   * this builder stays pure.
   */
  hostUser?: HostGitUser;
}

/**
 * Build the four `GIT_*` env vars for one agent. Pure — no I/O. Always returns
 * a valid, non-empty identity; falls back to a generic one when name is
 * missing.
 *
 * The agent's own identity: name = the plain display name (`Claudette`),
 * email = `<name-slug>.<discriminator>@alook.ai` (`claudette.9873@alook.ai`);
 * if the name has no ASCII-alphanumeric characters (all CJK/emoji) the
 * local-part is just the discriminator (`9873@alook.ai`), and if neither is
 * available it falls back to `alook-agent@alook.ai`.
 *
 * Two-author attribution: when `hostUser` carries a legible name AND email,
 * AUTHOR is set to the human owner and COMMITTER to the agent (git's native
 * author/committer split — "the human wrote it, the agent committed it"). With
 * no host identity, author and committer are both the agent (today's behavior).
 */
export function buildGitIdentityEnv(input: GitIdentityInput): Record<string, string> {
  const { agentName, discriminator, hostUser } = input;

  const cleanName = agentName ? sanitizeGitName(agentName) : "";
  const displayName = cleanName || FALLBACK_NAME;

  // Email local-part: `<name-slug>.<discriminator>`, joined with "." and
  // dropping any empty fragment (all-CJK name → discriminator only; neither →
  // generic fallback).
  const nameSlug = cleanName ? asciiSlug(cleanName) : "";
  const localPart =
    [nameSlug, discriminator].filter(Boolean).join(".") || FALLBACK_LOCAL_PART;
  const email = `${localPart}@${GIT_IDENTITY_DOMAIN}`;

  // Two-author split: only when the host owner has a legible name AND email
  // (partial/empty → not enough to attribute, keep agent-only). Sanitize the
  // host name the same way (it also becomes a git header line). The host email
  // is used verbatim except for CR/LF/control stripping — it is the owner's
  // real address, not something we mint.
  const hostName = hostUser?.name ? sanitizeGitName(hostUser.name) : "";
  const hostEmail = hostUser?.email ? sanitizeGitName(hostUser.email) : "";
  const hasHostAuthor = hostName !== "" && hostEmail !== "";

  return {
    GIT_AUTHOR_NAME: hasHostAuthor ? hostName : displayName,
    GIT_AUTHOR_EMAIL: hasHostAuthor ? hostEmail : email,
    GIT_COMMITTER_NAME: displayName,
    GIT_COMMITTER_EMAIL: email,
  };
}

let hostGitIdentityMemo: { value: HostGitUser | null } | undefined;

/**
 * Read the host owner's own git identity from their git config
 * (`git config --get user.name` / `user.email`). READ-ONLY: this only reads
 * the owner's existing config — it never writes `~/.gitconfig` or any repo's
 * `.git/config` (the module's env-only invariant is about not MUTATING the
 * owner's git state; reading their name/email to credit them as author does
 * not touch it). Returns `null` for a field the owner never set, and never
 * throws — any failure (git absent, config unset, timeout) degrades to no host
 * user, so `buildGitIdentityEnv` falls back to agent-only attribution.
 *
 * MEMOIZED for the daemon process: the host owner's git identity is static
 * across the process lifetime, and this sits on the per-spawn hot path (two
 * synchronous `git` forks otherwise), so the result — including `null` — is
 * cached after the first read. `resetHostGitIdentityCache()` clears it (tests).
 */
export function readHostGitIdentity(): HostGitUser | null {
  if (hostGitIdentityMemo) return hostGitIdentityMemo.value;

  // `read` distinguishes THREE outcomes, because caching a transient failure
  // as "no identity" would silently strip the owner's authorship for the whole
  // daemon lifetime (Blair's finding):
  //   - a value        → git ran, key set.
  //   - undefined      → git ran cleanly but the key is UNSET (a definitive
  //                      "not configured"; safe to cache).
  //   - transient=true → `git config` THREW (git missing / timed out / busy);
  //                      NOT definitive — don't cache, retry next spawn.
  let transient = false;
  const read = (key: string): string | undefined => {
    try {
      // `--get` exits 1 (no throw with our stdio) when the key is unset, so a
      // clean run with empty output = definitively unset, distinct from a throw.
      const out = execFileSync("git", ["config", "--get", key], {
        encoding: "utf8",
        timeout: HOST_GIT_READ_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out.length > 0 ? out : undefined;
    } catch (err) {
      // Exit-1 (unset key) is reported by execFileSync as a throw too, so
      // disambiguate: a non-zero EXIT (status is a number) = git ran, key
      // unset = definitive. No numeric status (ENOENT / ETIMEDOUT / signal) =
      // git couldn't answer = transient, must not be cached.
      const status = (err as { status?: unknown } | undefined)?.status;
      if (typeof status !== "number") transient = true;
      return undefined;
    }
  };

  const name = read("user.name");
  const email = read("user.email");
  const value = name === undefined && email === undefined ? null : { name, email };
  // Cache only a DEFINITIVE read. If any field's read threw a transient error,
  // leave the memo empty so the next spawn re-reads (the owner's real identity
  // isn't lost to one unlucky timeout at daemon start).
  if (!transient) hostGitIdentityMemo = { value };
  return value;
}

/** Clear the memoized host git identity (test-only; the value is static in prod). */
export function resetHostGitIdentityCache(): void {
  hostGitIdentityMemo = undefined;
}
