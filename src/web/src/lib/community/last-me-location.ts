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
  if (lastLeaf === null || !lastLeaf || !isSafeMeLeaf(lastLeaf)) {
    return `${ME_ROOT}/${FRIENDS_LEAF}`
  }
  return `${ME_ROOT}/${lastLeaf}`
}

export function resolveMeLocationStatus({
  pathname,
  dmId,
  dmRouteStatus,
}: {
  pathname: string
  dmId: string | undefined
  dmRouteStatus: "idle" | "pending" | "present" | "missing" | "error"
}): MeLocationStatus {
  if (!isRememberableMeLocation(pathname)) return "ignore"
  if (!dmId) return "remember"
  if (dmRouteStatus === "present") return "remember"
  if (dmRouteStatus === "missing") return "stale"
  return "wait"
}
