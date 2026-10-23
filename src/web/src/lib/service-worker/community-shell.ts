import { isCommunityApplicationPath } from "../community/application-route"

export const communityShellDirectory = "/community-shell/"
const shellPath = /^\/community-shell\/([a-f0-9]{64})$/

export function communityShellHash(pathname: string): string | undefined {
  return shellPath.exec(pathname)?.[1]
}

export function isCommunityShellAssetRequest(request: Request, origin: string, shellUrl: string): boolean {
  const url = new URL(request.url)
  return request.method === "GET" && url.origin === origin && url.pathname === shellUrl
    && !!communityShellHash(url.pathname) && !url.search && request.mode !== "navigate"
    && !request.headers.has("Authorization") && !request.headers.has("Cookie")
    && !request.headers.has("RSC") && !request.headers.has("Next-Router-State-Tree")
    && !request.headers.has("Next-Router-Prefetch") && !request.headers.get("Accept")?.includes("text/x-component")
}

export function isCommunityShellNavigation(request: Request, origin: string): boolean {
  const url = new URL(request.url)
  return request.method === "GET" && request.mode === "navigate" && url.origin === origin
    && isCommunityApplicationPath(url.pathname) && !request.headers.has("RSC")
    && !request.headers.has("Next-Router-State-Tree") && !request.headers.has("Next-Router-Prefetch")
    && !request.headers.get("Accept")?.includes("text/x-component")
}

export async function isCommunityShellResponse(request: Request, response: Response, shellUrl: string): Promise<boolean> {
  const url = new URL(request.url)
  const hash = communityShellHash(url.pathname)
  const cacheControl = response.headers.get("Cache-Control") ?? ""
  const vary = response.headers.get("Vary") ?? ""
  if (!hash || url.pathname !== shellUrl || response.status !== 200 || response.redirected
    || response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "text/html"
    || !/(?:^|,)\s*public\s*(?:,|$)/i.test(cacheControl)
    || /(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(cacheControl)
    || response.headers.has("Set-Cookie")
    || /(?:^|,)\s*(?:\*|cookie|authorization|rsc|next-router[^,]*)\s*(?:,|$)/i.test(vary)) return false
  const digest = await crypto.subtle.digest("SHA-256", await response.clone().arrayBuffer())
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") === hash
}
