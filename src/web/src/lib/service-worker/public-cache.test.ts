import { describe, expect, it } from "vitest"
import { isPublicAssetPath, isPublicAssetRequest, isPublicAssetResponse, restrictPublicPrecacheRoutes } from "./public-cache"
import { Route } from "serwist"

const origin = "https://alook.ai"
const script = "/_next/static/chunks/abcd1234.js"
const request = (path = script, init?: RequestInit) => new Request(new URL(path, origin), init)
const response = (headers?: HeadersInit, status = 200) => new Response("public bytes", {
  status,
  headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "application/javascript", ...headers },
})

describe("public service worker cache boundary", () => {
  it.each([script, "/_next/static/chunks/styles123.css", "/_next/static/media/font123.woff2", "/alook.svg", "/official-server-badge-flat.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png"])("allows a public asset: %s", path => {
    expect(isPublicAssetPath(path)).toBe(true)
    expect(isPublicAssetRequest(request(path), origin)).toBe(true)
  })

  it.each(["/c", "/c/channels/server/channel", "/sign-in", "/api/community/servers/icon", "/api/community/files/attachment", "/api/auth/get-session", "/_next/image", "/_next/static/chunks/code.js.map", "/_next/static/chunks/data.json", "/landing/unknown.svg", "/unknown.png", "/serwist/sw.js", "/sw.js"])("excludes private and unknown paths: %s", path => {
    expect(isPublicAssetPath(path)).toBe(false)
    expect(isPublicAssetRequest(request(path), origin)).toBe(false)
    expect(isPublicAssetResponse(request(path), response())).toBe(false)
  })

  it.each([
    { Authorization: "Bearer test" },
    { Cookie: "session=test" },
    { RSC: "1" },
    { "Next-Router-State-Tree": "[]" },
    { "Next-Router-Prefetch": "1" },
    { Accept: "text/x-component" },
  ])("does not intercept a credential or RSC request: %j", headers => {
    expect(isPublicAssetRequest(request(script, { headers }), origin)).toBe(false)
  })

  it("excludes writes, cross-origin assets, navigation and all query variants", () => {
    expect(isPublicAssetRequest(request(script, { method: "POST" }), origin)).toBe(false)
    expect(isPublicAssetRequest(request(script, { method: "HEAD" }), origin)).toBe(false)
    expect(isPublicAssetRequest(request(`https://other.example${script}`), origin)).toBe(false)
    for (const query of ["?_rsc=one", "?utm_source=one", "?download=one", "?__SW_REVISION__=one"]) {
      expect(isPublicAssetRequest(request(`${script}${query}`), origin)).toBe(false)
    }
    const document = request(script)
    Object.defineProperty(document, "destination", { value: "document" })
    expect(isPublicAssetRequest(document, origin)).toBe(false)
    const navigation = request(script)
    Object.defineProperty(navigation, "mode", { value: "navigate" })
    expect(isPublicAssetRequest(navigation, origin)).toBe(false)
  })

  it.each([
    { "Cache-Control": "private, max-age=600" },
    { "Cache-Control": "public, no-store" },
    { "Cache-Control": "public, no-cache" },
    { "Cache-Control": "max-age=600" },
    { "Set-Cookie": "session=test" },
    { Vary: "Accept-Encoding, Cookie" },
    { Vary: "Authorization" },
    { Vary: "RSC, Next-Router-State-Tree" },
    { Vary: "*" },
    { "Content-Type": "text/html" },
    { "Content-Type": "text/x-component" },
    { "Content-Type": "application/json" },
  ])("rejects unsafe responses even on a public path: %j", headers => {
    expect(isPublicAssetResponse(request(), response(headers))).toBe(false)
  })

  it("rejects errors and redirects and requires the correct asset content type", () => {
    expect(isPublicAssetResponse(request(), response())).toBe(true)
    expect(isPublicAssetResponse(request(), response({}, 404))).toBe(false)
    const redirected = response()
    Object.defineProperty(redirected, "redirected", { value: true })
    expect(isPublicAssetResponse(request(), redirected)).toBe(false)
    for (const [path, type] of [["/_next/static/chunks/abc.css", "text/css"], ["/_next/static/media/font.woff2", "font/woff2"], ["/alook.svg", "image/svg+xml"], ["/icon-192.png", "image/png"]]) {
      expect(isPublicAssetResponse(request(path), response({ "Content-Type": `${type}; charset=utf-8`, Vary: "Accept-Encoding" }))).toBe(true)
      expect(isPublicAssetResponse(request(path), response({ "Content-Type": "text/html" }))).toBe(false)
    }
  })

  it("guards Serwist's actual route match while retaining its revision parameters", () => {
    const params = { cacheKey: `${origin}${script}?__SW_REVISION__=revision` }
    const route = new Route(() => params, () => Promise.resolve(response()))
    restrictPublicPrecacheRoutes({ routes: new Map([["GET", [route]]]) }, origin)
    const options = (req: Request) => ({ request: req, url: new URL(req.url), sameOrigin: true, event: new Event("fetch") as FetchEvent })
    expect(route.match(options(request()))).toEqual(params)
    expect(route.match(options(request(script, { headers: { Authorization: "test" } })))).toBe(false)
    expect(route.match(options(request("/api/auth/get-session")))).toBe(false)
    expect(route.match(options(request(`${script}?_rsc=value`)))).toBe(false)
  })
})
