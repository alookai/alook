// Per-server "last opened channel" navigation memory (pure client). Re-entering
// a server otherwise always lands on the first channel, discarding where you
// were; this remembers, per browser, the last channel/post opened in each
// server so the server-landing page can restore to it.
//
// Deliberately narrow: it stores ONLY which channel (a serverId -> channelId
// map), never scroll position or read-to-seq — those are server read-state, a
// separate concern this must not touch. localStorage-only (no backend, no
// daemon, no cross-device sync). Pure guarded wrappers (SSR + privacy-mode safe)
// mirroring `composer-draft.ts` — any failure degrades to "no memory", i.e.
// exactly today's default-channel behavior, never a throw.

const PREFIX = "community:lastChannel:"

export function lastChannelKey(serverId: string): string {
  return `${PREFIX}${serverId}`
}

export function getLastChannel(serverId: string): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(lastChannelKey(serverId))
  } catch {
    return null
  }
}

export function setLastChannel(serverId: string, channelId: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(lastChannelKey(serverId), channelId)
  } catch {
    // Best-effort: private-mode / quota failures just mean no memory this
    // session, which falls back to the default channel — never surface it.
  }
}

/**
 * Forget the remembered channel for a server. Called when the remembered id
 * turns out to be unopenable (deleted / no-access / garbage) so the next
 * server-landing has no memory and picks the default — WITHOUT this, a
 * server-root → dead-id → bounce-to-server-root cycle re-reads the same dead id
 * forever (the redirect loop this breaks). Same SSR / privacy-mode guard as the
 * setters; a failure just means the stale id lingers, never a throw.
 */
export function clearLastChannel(serverId: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(lastChannelKey(serverId))
  } catch {
    /* best-effort — see setLastChannel */
  }
}

/**
 * Pick which channel the server-landing page should redirect to: the remembered
 * `last` channel when there is one, else the first top-level channel by position.
 * `undefined` when the server has no channels and there's no memory.
 *
 * `last` is trusted and returned directly — it is NOT validated against
 * `channelIds`. `channelIds` (the server's TOP-LEVEL channels) is only the
 * source for the DEFAULT when there's no memory. This is deliberate: a
 * remembered channel may be a FORUM POST or THREAD (a child channel — its id
 * lives under a forum/parent, never in the top-level list), so validating `last`
 * against the top-level list would drop every remembered post/thread and always
 * fall back to default (the bug this fixes). Instead the landing page navigates
 * to `last` and the destination `[channelId]` page validates it: a real
 * child-channel renders its opener view; a deleted / no-longer-accessible /
 * outright-garbage id fails its meta fetch and bounces back to default (see the
 * 404||403 bounce in that page). "Trust the id" ≠ "trust the id is valid" —
 * validity is the destination's job, not this selector's. Extracted pure so the
 * rule is unit-tested without a page-render harness.
 */
export function pickServerLandingChannel(
  channelIds: readonly string[],
  last: string | null,
): string | undefined {
  if (last !== null) return last
  return channelIds[0]
}
