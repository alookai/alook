import {
  clearLastChannel,
  getLastChannel,
  lastChannelKey,
  setLastChannel,
} from "./last-channel"

const ME_SCOPE_ID = "me"
export const ME_ROOT = "/c/me"
const FRIENDS_LEAF = "friends"

export type MeLocationStatus = "ignore" | "wait" | "remember" | "stale"

function isSafeMeLeaf(leaf: string): boolean {
  return leaf !== "." && leaf !== ".." && !/[\/\\?#\s]/.test(leaf)
}

export function lastMeLocationKey(): string {
  return lastChannelKey(ME_SCOPE_ID)
}

export function meLeafFromPathname(pathname: string): string | null {
  if (pathname === ME_ROOT) return FRIENDS_LEAF
  const prefix = `${ME_ROOT}/`
  if (!pathname.startsWith(prefix)) return null
  const leaf = pathname.slice(prefix.length)
  return leaf && isSafeMeLeaf(leaf) ? leaf : null
}

export function isRememberableMeLocation(pathname: string): boolean {
  return meLeafFromPathname(pathname) !== null
}

export function getLastMeLeaf(): string | null {
  return getLastChannel(ME_SCOPE_ID)
}

export function setLastMeLocation(pathname: string): void {
  const leaf = meLeafFromPathname(pathname)
  if (leaf === null) return
  setLastChannel(ME_SCOPE_ID, leaf)
}

export function clearLastMeLocation(): void {
  clearLastChannel(ME_SCOPE_ID)
}

export function pickMeLandingLocation(lastLeaf: string | null): string {
  if (lastLeaf === null || !lastLeaf || !isSafeMeLeaf(lastLeaf)) return ME_ROOT
  return lastLeaf === FRIENDS_LEAF ? ME_ROOT : `${ME_ROOT}/${lastLeaf}`
}

export function resolveMeLocationStatus({
  pathname,
  dmId,
  dmsReady,
  dmIds,
}: {
  pathname: string
  dmId: string | undefined
  dmsReady: boolean
  dmIds: readonly string[]
}): MeLocationStatus {
  if (!isRememberableMeLocation(pathname)) return "ignore"
  if (!dmId) return "remember"
  if (!dmsReady) return "wait"
  return dmIds.includes(dmId) ? "remember" : "stale"
}
