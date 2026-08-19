export type CommunitySurface = "list" | "detail"

export type CommunityRoute = {
  surface: CommunitySurface
  parentPath: string | null
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
    if (segments.length >= 5) {
      return {
        surface: "detail",
        parentPath: `${serverRoot}/${segments[3]}`,
      }
    }
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

export function childChannelHref(
  serverId: string,
  parentChannelId: string,
  childChannelId: string,
): string {
  return `${channelHref(serverId, parentChannelId)}/${childChannelId}`
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
