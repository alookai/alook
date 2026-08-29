export type CommunitySurface = "list" | "detail"

type CommunityModuleRoute =
  | "community-root-redirect"
  | "me-root"
  | "me-friends"
  | "me-machines"
  | "me-bots"
  | "dm-detail"
  | "server-root"
  | "server-detail"
  | "server-settings-redirect"
  | "public-invite"
  | "unknown"

type CommunityModuleMain =
  | { kind: "me-root" }
  | { kind: "friends" }
  | { kind: "machines" }
  | { kind: "bots" }
  | { kind: "dm"; dmId: string }
  | { kind: "server-landing"; serverId: string }
  | { kind: "server-conversation"; serverId: string; leafId: string }
  | { kind: "route-resolution" }
  | { kind: "none" }

export type CommunityModulePlan = {
  route: CommunityModuleRoute
  canonicalHref?: string
  surface: CommunitySurface | "neutral"
  rail: "community" | "none"
  sidebar:
    | { kind: "me" }
    | { kind: "server"; serverId: string }
    | { kind: "none" }
  main: CommunityModuleMain
}

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
  const sidebar = resolveCommunityModulePlan(href).sidebar
  return sidebar.kind === "server" ? sidebar.serverId : null
}

function unknownCommunityModulePlan(): CommunityModulePlan {
  return {
    route: "unknown",
    surface: "neutral",
    rail: "none",
    sidebar: { kind: "none" },
    main: { kind: "route-resolution" },
  }
}

function structuralPathname(href: string): string {
  return href.split(/[?#]/, 1)[0] || "/"
}

function decodedPathSegments(pathname: string): string[] | null {
  if (!pathname.startsWith("/")) return null
  const raw = pathname.slice(1).split("/")
  if (raw.at(-1) === "") raw.pop()
  if (raw.some((segment) => segment.length === 0)) return null
  try {
    const decoded = raw.map((segment) => decodeURIComponent(segment))
    if (decoded.some((segment) => !segment || /[/?#\\]/.test(segment))) return null
    return decoded
  } catch {
    return null
  }
}

export function resolveCommunityModulePlan(href: string): CommunityModulePlan {
  const segments = decodedPathSegments(structuralPathname(href))
  if (!segments || segments[0] !== "c") return unknownCommunityModulePlan()

  if (segments.length === 1) {
    return {
      route: "community-root-redirect",
      canonicalHref: "/c/me/machines",
      surface: "detail",
      rail: "community",
      sidebar: { kind: "me" },
      main: { kind: "machines" },
    }
  }

  if (segments[1] === "invite" && segments.length === 3) {
    return {
      route: "public-invite",
      surface: "neutral",
      rail: "none",
      sidebar: { kind: "none" },
      main: { kind: "none" },
    }
  }

  if (segments[1] === "me") {
    if (segments.length === 2) {
      return {
        route: "me-root",
        surface: "list",
        rail: "community",
        sidebar: { kind: "me" },
        main: { kind: "me-root" },
      }
    }
    if (segments.length !== 3) return unknownCommunityModulePlan()
    const leaf = segments[2]!
    if (leaf === "friends") {
      return {
        route: "me-friends",
        surface: "detail",
        rail: "community",
        sidebar: { kind: "me" },
        main: { kind: "friends" },
      }
    }
    if (leaf === "machines") {
      return {
        route: "me-machines",
        surface: "detail",
        rail: "community",
        sidebar: { kind: "me" },
        main: { kind: "machines" },
      }
    }
    if (leaf === "bots") {
      return {
        route: "me-bots",
        surface: "detail",
        rail: "community",
        sidebar: { kind: "me" },
        main: { kind: "bots" },
      }
    }
    return {
      route: "dm-detail",
      surface: "detail",
      rail: "community",
      sidebar: { kind: "me" },
      main: { kind: "dm", dmId: leaf },
    }
  }

  if (segments[1] === "channels") {
    if (segments.length < 3 || segments.length > 4) return unknownCommunityModulePlan()
    const serverId = segments[2]!
    const sidebar = { kind: "server" as const, serverId }
    if (segments.length === 3) {
      return {
        route: "server-root",
        surface: "list",
        rail: "community",
        sidebar,
        main: { kind: "server-landing", serverId },
      }
    }
    const leafId = segments[3]!
    if (leafId === "settings") {
      return {
        route: "server-settings-redirect",
        canonicalHref: `/c/channels/${encodeURIComponent(serverId)}`,
        surface: "list",
        rail: "community",
        sidebar,
        main: { kind: "server-landing", serverId },
      }
    }
    return {
      route: "server-detail",
      surface: "detail",
      rail: "community",
      sidebar,
      main: { kind: "server-conversation", serverId, leafId },
    }
  }

  return unknownCommunityModulePlan()
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
  const modulePlan = resolveCommunityModulePlan(pathname)
  const scope: CommunityScope = modulePlan.sidebar.kind === "server"
    ? { kind: "server", serverId: modulePlan.sidebar.serverId }
    : modulePlan.sidebar.kind === "me"
      ? { kind: "me" }
      : { kind: "unknown" }
  return {
    href: `${pathname}${search ? `?${search}` : ""}`,
    pathname,
    search,
    scope,
    surface: modulePlan.surface === "list" ? "list" : "detail",
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
  const plan = resolveCommunityModulePlan(pathname)
  if (plan.route === "dm-detail" || plan.route.startsWith("me-")) {
    return plan.surface === "detail"
      ? { surface: "detail", parentPath: "/c/me" }
      : { surface: "list", parentPath: null }
  }
  if (plan.sidebar.kind === "server") {
    return plan.surface === "detail"
      ? { surface: "detail", parentPath: serverRootHref(plan.sidebar.serverId) }
      : { surface: "list", parentPath: null }
  }
  return { surface: plan.surface === "list" ? "list" : "detail", parentPath: null }
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
