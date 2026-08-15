export type MobileZone = "nav" | "messages"

const MOBILE_ZONE_QUERY_KEY = "pane"

type SearchParamsReader = {
  get: (name: string) => string | null
}

export function resolveMobileZone(searchParams: SearchParamsReader): MobileZone {
  return searchParams.get(MOBILE_ZONE_QUERY_KEY) === "nav" ? "nav" : "messages"
}

export function withMobileZone(href: string, zone: MobileZone): string {
  return updateHrefSearchParams(href, (searchParams) => {
    if (zone === "nav") searchParams.set(MOBILE_ZONE_QUERY_KEY, "nav")
    else searchParams.delete(MOBILE_ZONE_QUERY_KEY)
  })
}

export function removeCommunityParam(href: string, key: string): string {
  return updateHrefSearchParams(href, (searchParams) => {
    searchParams.delete(key)
  })
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
