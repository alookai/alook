export type CommunitySurface = "list" | "detail"

export type CommunityRoute = {
  surface: CommunitySurface
  parentPath: string | null
}

type CommunityScope =
  | { kind: "server"; serverId: string }
  | { kind: "me" }
  | { kind: "unknown" }

export type CommunityHref = {
  href: string
  pathname: string
  search: string
  scope: CommunityScope
  surface: CommunitySurface
  leafKey: string
}

export type CommunityCommittedFrame = CommunityHref & {
  revision: number
}

export type CommunityCheckpointPlan = {
  mode: "committed" | "same-scope-leaf" | "warm-scope" | "cold-scope"
  surface: CommunitySurface
  targetHref: string
  rail:
    | { kind: "keep" }
    | { kind: "target"; view: "dm" | "server"; activeServerId?: string }
  sidebar:
    | { kind: "keep" }
    | { kind: "server-skeleton"; serverId: string }
    | { kind: "me-skeleton" }
  main: { kind: "keep" } | { kind: "target-skeleton"; href: string }
}

export function communityServerId(href: string): string | null {
  const pathname = href.split(/[?#]/, 1)[0]
  const segments = pathname?.split("/").filter(Boolean) ?? []
  return segments[0] === "c" && segments[1] === "channels" && segments[2]
    ? segments[2]
    : null
}

export function normalizeCommunityHref(href: string): CommunityHref {
  const hashIndex = href.indexOf("#")
  const withoutHash = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf("?")
  const pathname = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)
  const searchParams = new URLSearchParams(
    queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1),
  )
  searchParams.sort()
  const search = searchParams.toString()
  const segments = pathname.split("/").filter(Boolean)
  const scope: CommunityScope = segments[0] === "c" && segments[1] === "channels" && segments[2]
    ? { kind: "server", serverId: segments[2] }
    : segments[0] === "c" && segments[1] === "me"
      ? { kind: "me" }
      : { kind: "unknown" }
  return {
    href: `${pathname}${search ? `?${search}` : ""}`,
    pathname,
    search,
    scope,
    surface: resolveCommunityRoute(pathname).surface,
    leafKey: pathname,
  }
}

function communityScopeEqual(a: CommunityScope, b: CommunityScope): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "server" && b.kind === "server") return a.serverId === b.serverId
  return a.kind !== "unknown"
}

export function isPublishedNonStructuralCommit(
  committedFrame: CommunityCommittedFrame,
  publishedHref: string,
  targetHref: string,
): boolean {
  const published = normalizeCommunityHref(publishedHref)
  const target = normalizeCommunityHref(targetHref)
  return committedFrame.leafKey === target.leafKey && published.href === target.href
}

export function isStructuralFrameCommit({
  committedFrame,
  targetHref,
  baselineRevision,
}: {
  committedFrame: CommunityCommittedFrame
  targetHref: string
  baselineRevision: number
}): boolean {
  if (committedFrame.revision <= baselineRevision) return false
  return committedFrame.leafKey === normalizeCommunityHref(targetHref).leafKey
}

export function advanceCommunityCommittedFrame(
  current: CommunityCommittedFrame,
  href: string,
): CommunityCommittedFrame {
  const next = normalizeCommunityHref(href)
  if (current.leafKey === next.leafKey) return current
  return { ...next, revision: current.revision + 1 }
}

export function resolveCommunityCheckpointPlan({
  committedFrame,
  targetHref,
  pending,
  targetReady,
}: {
  committedFrame: CommunityCommittedFrame
  targetHref: string | null
  pending: boolean
  targetReady: boolean
}): CommunityCheckpointPlan {
  if (!pending || !targetHref) {
    return committedPlan(committedFrame)
  }

  const target = normalizeCommunityHref(targetHref)
  if (target.scope.kind === "unknown" || target.leafKey === committedFrame.leafKey) {
    return committedPlan(committedFrame, target.href)
  }

  if (communityScopeEqual(committedFrame.scope, target.scope)) {
    return {
      mode: "same-scope-leaf",
      surface: committedFrame.surface,
      targetHref: target.href,
      rail: { kind: "keep" },
      sidebar: { kind: "keep" },
      main: { kind: "keep" },
    }
  }

  if (targetReady) {
    return {
      ...committedPlan(committedFrame, target.href),
      mode: "warm-scope",
    }
  }

  const rail = target.scope.kind === "server"
    ? { kind: "target" as const, view: "server" as const, activeServerId: target.scope.serverId }
    : { kind: "target" as const, view: "dm" as const }
  const sidebar = target.scope.kind === "server"
    ? { kind: "server-skeleton" as const, serverId: target.scope.serverId }
    : { kind: "me-skeleton" as const }
  return {
    mode: "cold-scope",
    surface: target.surface,
    targetHref: target.href,
    rail,
    sidebar,
    main: { kind: "target-skeleton", href: target.href },
  }
}

function committedPlan(
  frame: CommunityCommittedFrame,
  targetHref = frame.href,
): CommunityCheckpointPlan {
  return {
    mode: "committed",
    surface: frame.surface,
    targetHref,
    rail: { kind: "keep" },
    sidebar: { kind: "keep" },
    main: { kind: "keep" },
  }
}

export function resolveCommunityRoute(pathname: string): CommunityRoute {
  const segments = pathname.split("/").filter(Boolean)
  if (segments[0] !== "c") return { surface: "detail", parentPath: null }

  if (segments[1] === "me") {
    return segments.length === 2
      ? { surface: "list", parentPath: null }
      : { surface: "detail", parentPath: "/c/me" }
  }

  if (segments[1] === "channels" && segments[2]) {
    const serverRoot = `/c/channels/${segments[2]}`
    if (segments.length === 3) return { surface: "list", parentPath: null }
    return { surface: "detail", parentPath: serverRoot }
  }

  return { surface: "detail", parentPath: null }
}

export function serverRootHref(serverId: string): string {
  return `/c/channels/${serverId}`
}

export function channelHref(serverId: string, channelId: string): string {
  return `${serverRootHref(serverId)}/${channelId}`
}

export function removeCommunityParam(href: string, key: string): string {
  return updateHrefSearchParams(href, (searchParams) => {
    searchParams.delete(key)
  })
}

export function serverModalMarkerCleanupHref(
  href: string,
  {
    breakpoint,
    hasChannel,
    hasServerChannels,
  }: {
    breakpoint: "unknown" | "desktop" | "mobile"
    hasChannel: boolean
    hasServerChannels: boolean
  },
): string | null {
  const hashIndex = href.indexOf("#")
  const hrefWithoutHash = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const queryIndex = hrefWithoutHash.indexOf("?")
  const searchParams = new URLSearchParams(
    queryIndex === -1 ? "" : hrefWithoutHash.slice(queryIndex + 1),
  )
  const hasModalMarker =
    searchParams.get("settings") === "1" || searchParams.get("invite") === "1"
  if (!hasModalMarker) return null

  if (breakpoint === "desktop" && !hasChannel && hasServerChannels) return null

  return removeCommunityParam(removeCommunityParam(href, "settings"), "invite")
}

function updateHrefSearchParams(
  href: string,
  update: (searchParams: URLSearchParams) => void,
): string {
  const hashIndex = href.indexOf("#")
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex)
  const hrefWithoutHash = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const queryIndex = hrefWithoutHash.indexOf("?")
  const pathname = queryIndex === -1
    ? hrefWithoutHash
    : hrefWithoutHash.slice(0, queryIndex)
  const query = queryIndex === -1 ? "" : hrefWithoutHash.slice(queryIndex + 1)
  const searchParams = new URLSearchParams(query)

  update(searchParams)

  const nextQuery = searchParams.toString()
  return `${pathname}${nextQuery ? `?${nextQuery}` : ""}${hash}`
}
