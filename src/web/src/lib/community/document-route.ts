import { resolveCommunityModulePlan } from "./community-route"

export const COMMUNITY_DOCUMENT_ROUTE_HEADER = "x-alook-community-document-route"
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function communityDocumentRoute(url: URL): string | null {
  const main = resolveCommunityModulePlan(url.pathname).main
  if (!["bots", "machines", "dm", "server-landing", "server-conversation"].includes(main.kind)) return null
  const params = new URLSearchParams()
  const anchor = url.searchParams.get("msg")
  if (anchor !== null) {
    if (!RESOURCE_ID.test(anchor)) return null
    params.set("msg", anchor)
  }
  const tag = url.searchParams.get("tag")
  if (tag !== null) {
    if (tag.length > 100 || /[\u0000-\u001f\u007f]/.test(tag)) return null
    params.set("tag", tag)
  }
  const result = `${url.pathname}${params.size ? `?${params}` : ""}`
  return result.length <= 2048 ? result : null
}

export function readCommunityDocumentRoute(value: string | null): string | null {
  if (!value || !value.startsWith("/c/") || value.length > 2048) return null
  const canonical = communityDocumentRoute(new URL(value, "https://alook.invalid"))
  return canonical === value ? canonical : null
}
