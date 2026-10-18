import { normalizeCommunityHref } from "./community-route"

export const COMMUNITY_NAV_FORWARD = "community-nav-forward"
export const COMMUNITY_NAV_BACK = "community-nav-back"

export function communityNavigationTransitionTypes(
  fromHref: string,
  toHref: string,
  parentHref?: string | null,
  transitionTypes?: string[],
): string[] {
  if (transitionTypes !== undefined) return transitionTypes
  const from = normalizeCommunityHref(fromHref)
  const to = normalizeCommunityHref(toHref)
  if (from.leafKey === to.leafKey) return []
  if (from.scope.kind === "unknown" || to.scope.kind === "unknown") return []
  const sameScope = from.scope.kind === "me" && to.scope.kind === "me"
    || from.scope.kind === "server" && to.scope.kind === "server"
      && from.scope.serverId === to.scope.serverId
  if (!sameScope && to.surface === "list") return []
  if (parentHref && to.leafKey === normalizeCommunityHref(parentHref).leafKey
    || sameScope && from.surface === "detail" && to.surface === "list") {
    return [COMMUNITY_NAV_BACK]
  }
  return [COMMUNITY_NAV_FORWARD]
}
