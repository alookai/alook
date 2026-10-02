// Per-server "last opened channel" navigation memory (pure client). Re-entering
// a server otherwise always lands on the first channel, discarding where you
// were; this remembers, per browser, the last channel/post opened in each
// server so the server-landing page can restore to it.
//
// Deliberately narrow: it stores ONLY one channel id per server, never scroll
// position or read-to-seq — those are
// server read-state, a separate concern this must not touch. localStorage-only
// (no backend, no daemon, no cross-device sync). Pure guarded wrappers (SSR +
// privacy-mode safe) mirroring `composer-draft.ts` — any failure degrades to
// "no memory", i.e. exactly today's default-channel behavior, never a throw.

import {
  clearNavigationMemory,
  readNavigationMemory,
  writeNavigationMemory,
} from "./navigation-memory"

const PREFIX = "community:lastChannel:"

export function lastChannelKey(serverId: string): string {
  return `${PREFIX}${serverId}`
}

export function getLastChannel(serverId: string): string | null {
  const key = lastChannelKey(serverId)
  const channelId = readNavigationMemory(key)
  if (channelId?.includes("/")) {
    clearNavigationMemory(key)
    return null
  }
  return channelId
}

export function setLastChannel(serverId: string, channelId: string): void {
  const key = lastChannelKey(serverId)
  if (channelId.includes("/")) {
    clearNavigationMemory(key)
    return
  }
  writeNavigationMemory(key, channelId)
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
  clearNavigationMemory(lastChannelKey(serverId))
}

export function pickServerLandingHref(
  serverId: string,
  channelIds: readonly string[],
  last: string | null,
): string {
  return resolveCommunityLandingHref({ serverId, channelIds, last })
}

export function resolveCommunityLandingHref({
  serverId,
  channelIds = [],
  last,
  breakpoint = "desktop",
}: {
  serverId: string | null
  channelIds?: readonly string[]
  last: string | null
  breakpoint?: "unknown" | "desktop" | "mobile"
}): string {
  const root = serverId === null ? "/c/me" : `/c/channels/${encodeURIComponent(serverId)}`
  if (breakpoint !== "desktop") return root
  const safeLast = last && last !== "." && last !== ".." && !/[\\/?#\s]/.test(last)
    ? last
    : null
  const leaf = safeLast ?? (serverId === null ? "friends" : channelIds[0])
  return leaf ? `${root}/${encodeURIComponent(leaf)}` : root
}
