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
 * Pick which channel the server-landing page should redirect to: the remembered
 * `last` channel when it still exists among the server's currently-visible
 * `channelIds` (a deleted / no-longer-accessible id isn't in the list → falls
 * through — this IS the graceful fallback, no error path needed), else the
 * first channel by position. `undefined` when the server has no channels.
 * Extracted pure so the selection rule is unit-tested without a page-render
 * harness.
 */
export function pickServerLandingChannel(
  channelIds: readonly string[],
  last: string | null,
): string | undefined {
  if (last !== null && channelIds.includes(last)) return last
  return channelIds[0]
}
