import { resolveCommunityModulePlan } from "./community-route"
import {
  clearNavigationMemory,
  readNavigationMemory,
  writeNavigationMemory,
} from "./navigation-memory"

const PREFIX = "community:lastRoute:"
export const COMMUNITY_COLD_ENTRY_FALLBACK = "/c/me/machines"

const activeRestoreByAccount = new Map<string, string>()

export function lastCommunityRouteKey(accountId: string): string {
  return `${PREFIX}${encodeURIComponent(accountId)}`
}

export function canonicalCommunityLeafPathname(href: string): string | null {
  const pathname = href.split(/[?#]/, 1)[0] || "/"
  const plan = resolveCommunityModulePlan(pathname)

  if (plan.route === "me-friends") return "/c/me/friends"
  if (plan.route === "me-machines") return "/c/me/machines"
  if (plan.route === "me-bots") return "/c/me/bots"
  if (plan.main.kind === "dm") {
    return `/c/me/${encodeURIComponent(plan.main.dmId)}`
  }
  if (plan.main.kind === "server-conversation") {
    return `/c/channels/${encodeURIComponent(plan.main.serverId)}/${encodeURIComponent(plan.main.leafId)}`
  }
  return null
}

export function getLastCommunityRoute(accountId: string): string | null {
  if (!accountId) return null
  const key = lastCommunityRouteKey(accountId)
  const stored = readNavigationMemory(key)
  if (!stored) return null
  const canonical = canonicalCommunityLeafPathname(stored)
  if (!canonical) {
    clearNavigationMemory(key)
    return null
  }
  if (canonical !== stored) writeNavigationMemory(key, canonical)
  return canonical
}

export function commitLastCommunityRoute(accountId: string, href: string): string | null {
  const canonical = canonicalCommunityLeafPathname(href)
  if (!accountId || !canonical) return null
  writeNavigationMemory(lastCommunityRouteKey(accountId), canonical)
  activeRestoreByAccount.delete(accountId)
  return canonical
}

export function resolveCommunityColdEntryDestination({
  accountId,
  pathname,
  search,
  hash,
}: {
  accountId: string
  pathname: string
  search: string
  hash: string
}): string {
  if (accountId) activeRestoreByAccount.delete(accountId)
  if (pathname !== "/c" || search !== "" || hash !== "") {
    return COMMUNITY_COLD_ENTRY_FALLBACK
  }
  const destination = getLastCommunityRoute(accountId)
  if (!destination) return COMMUNITY_COLD_ENTRY_FALLBACK
  activeRestoreByAccount.set(accountId, destination)
  return destination
}

export function consumeCommunityColdEntryFailure(accountId: string, href: string): boolean {
  const canonical = canonicalCommunityLeafPathname(href)
  if (!accountId || !canonical || activeRestoreByAccount.get(accountId) !== canonical) {
    return false
  }
  activeRestoreByAccount.delete(accountId)
  clearNavigationMemory(lastCommunityRouteKey(accountId))
  return true
}

export function retireCommunityColdEntryAttempt(accountId: string, href: string): boolean {
  const target = activeRestoreByAccount.get(accountId)
  if (!target) return false

  const pathname = href.split(/[?#]/, 1)[0] || "/"
  if (pathname === "/c" || canonicalCommunityLeafPathname(href) === target) {
    return false
  }

  activeRestoreByAccount.delete(accountId)
  return true
}

export function clearCommunityColdEntryAttempts(): void {
  activeRestoreByAccount.clear()
}
