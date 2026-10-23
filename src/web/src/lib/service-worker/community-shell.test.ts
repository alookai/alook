import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { communityShellHash, isCommunityShellAssetRequest, isCommunityShellNavigation, isCommunityShellResponse } from "./community-shell"

const origin = "https://alook.test"
const html = '<html><main data-community-shell="public">Loading</main></html>'
const hash = createHash("sha256").update(html).digest("hex")
const shell = `/community-shell/${hash}`
const request = (pathname: string, headers?: HeadersInit) => new Request(`${origin}${pathname}`, { headers })
function navigation(pathname: string, headers?: HeadersInit) {
  const req = request(pathname, headers)
  Object.defineProperty(req, "mode", { value: "navigate" })
  return req
}
const response = (headers: HeadersInit = {}, body = html) => new Response(body, { headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "text/html; charset=utf-8", ...headers } })

describe("immutable anonymous community shell", () => {
  it("uses an exact content hash URL rather than admitting arbitrary HTML", () => {
    expect(communityShellHash(shell)).toBe(hash)
    for (const path of ["/c", "/app.html", `${shell}.html`, `${shell}/`, "/community-shell/../c", `/community-shell/${hash.toUpperCase()}`]) expect(communityShellHash(path), path).toBeUndefined()
    expect(isCommunityShellAssetRequest(request(shell), origin, shell)).toBe(true)
    for (const req of [request(`${shell}?user=a`), request(shell, { Cookie: "session=fixture" }), request(shell, { RSC: "1" }), request(shell, { Authorization: "fixture" }), navigation(shell), new Request(`https://other.test${shell}`)]) expect(isCommunityShellAssetRequest(req, origin, shell)).toBe(false)
  })
  it.each(["/c", "/c/me", "/c/me/machines", "/c/me/bots", "/c/me/friends", "/c/me/dm-a?seq=3", "/c/channels/s", "/c/channels/s/forum-a", "/c/channels/s/settings", "/c/messages/message-a"])("serves the same public shell for a known navigation %s", path => {
    expect(isCommunityShellNavigation(navigation(path, { Cookie: "session=fixture" }), origin)).toBe(true)
  })
  it.each(["/", "/sign-in", "/auth/native/return", "/api/auth/get-session", "/api/community/users/me/profile", "/c/invite/token", "/c/invite/token/extra", "/c/unknown/extra"])("leaves non-app path %s outside navigation routing", path => {
    expect(isCommunityShellNavigation(navigation(path), origin)).toBe(false)
  })
  it("never handles RSC, ordinary fetches, writes or cross-origin documents", () => {
    expect(isCommunityShellNavigation(request("/c"), origin)).toBe(false)
    for (const headers of [{ RSC: "1" }, { "Next-Router-State-Tree": "tree" }, { "Next-Router-Prefetch": "1" }, { Accept: "text/x-component" }]) expect(isCommunityShellNavigation(navigation("/c", headers), origin)).toBe(false)
    expect(isCommunityShellNavigation(new Request(`${origin}/c`, { method: "POST" }), origin)).toBe(false)
    expect(isCommunityShellNavigation(navigation("/c"), "https://other.test")).toBe(false)
  })
  it("admits only exact public HTML bytes for the current build", async () => {
    expect(await isCommunityShellResponse(request(shell), response(), shell)).toBe(true)
    expect(await isCommunityShellResponse(request(shell), response({}, `${html}changed`), shell)).toBe(false)
    expect(await isCommunityShellResponse(request("/app.html"), response(), shell)).toBe(false)
    for (const headers of [{ "Cache-Control": "private, no-store" }, { "Cache-Control": "public, no-cache" }, { "Cache-Control": "max-age=3600" }, { "Set-Cookie": "fixture=x" }, { Vary: "Cookie" }, { Vary: "RSC" }, { Vary: "Next-Router-State-Tree" }, { "Content-Type": "application/json" }]) expect(await isCommunityShellResponse(request(shell), response(headers), shell)).toBe(false)
    expect(await isCommunityShellResponse(request(shell), new Response(html, { status: 500 }), shell)).toBe(false)
    const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true })
    expect(await isCommunityShellResponse(request(shell), redirected, shell)).toBe(false)
  })
})
