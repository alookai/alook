import { describe, expect, it } from "vitest"
import { isPublicAssetPath, isPublicAssetRequest, isPublicAssetResponse, publicRuntimeAssetKind, restrictPublicPrecacheRoutes } from "./public-cache"
import { Route } from "serwist"
import imageAssets from "../../../blog/src/lib/blog/image-assets.json"

const origin = "https://alook.ai"
const script = "/_next/static/chunks/abcd1234.js"
const request = (path = script, init?: RequestInit) => new Request(new URL(path, origin), init)
const response = (headers?: HeadersInit, status = 200) => new Response("public bytes", {
  status,
  headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "application/javascript", ...headers },
})

describe("public service worker cache boundary", () => {
  it.each(["227o87hfvs4zs", "abc123"])("admits only the framework favicon metadata query: %s", fingerprint => {
    const path = `/favicon.ico?favicon.${fingerprint}.ico`
    expect(isPublicAssetRequest(request(path), origin)).toBe(true)
    expect(isPublicAssetResponse(request(path), response({ "Content-Type": "image/x-icon" }))).toBe(true)
    for (const headers of [{ Authorization: "fixture" }, { Cookie: "fixture" }, { RSC: "1" }, { "Next-Router-State-Tree": "[]" }] as HeadersInit[]) expect(isPublicAssetRequest(request(path, { headers }), origin)).toBe(false)
    expect(isPublicAssetRequest(request(`https://other.test${path}`), origin)).toBe(false)
    expect(isPublicAssetRequest(request(path, { method: "POST" }), origin)).toBe(false)
    const navigation = request(path)
    Object.defineProperty(navigation, "mode", { value: "navigate" })
    expect(isPublicAssetRequest(navigation, origin)).toBe(false)
  })

  it.each([
    "/favicon.ico?favicon.abc123.ico=", "/favicon.ico?favicon.abc123.ico=one",
    "/favicon.ico?favicon.abc123.ico&x=one", "/favicon.ico?favicon.abc123.ico&",
    "/favicon.ico?favicon.abc123.ico&favicon.abc123.ico", "/favicon.ico?favicon..ico",
    "/favicon.ico?favicon.ABC123.ico", "/favicon.ico?%66avicon.abc123.ico",
    "/favicon.ico?favicon.%61bc123.ico", "/favicon.ico?__WB_REVISION__=fixture",
    "/favicon.ico?__SW_REVISION__=fixture", "/favicon.ico?_rsc=one",
    "/_next/static/chunks/abcd1234.js?favicon.abc123.ico", "/blog/example-article/hero.webp?favicon.abc123.ico",
  ])("rejects value, duplicate, encoded and unrelated query variants: %s", path => {
    expect(isPublicAssetRequest(request(path), origin)).toBe(false)
  })
  it("admits the current Blog image catalog and every responsive srcSet URL", () => {
    for (const [path, asset] of Object.entries(imageAssets)) {
      const paths = [path, ...("srcSet" in asset && typeof asset.srcSet === "string" ? asset.srcSet.split(",").map(value => value.trim().split(/\s+/)[0]) : [])]
      for (const url of paths) {
        expect(publicRuntimeAssetKind(url), url).toBe("images")
        expect(isPublicAssetRequest(request(url), origin), url).toBe(true)
        expect(isPublicAssetResponse(request(url), response({ "Content-Type": url.endsWith(".svg") ? "image/svg+xml" : url.endsWith(".png") ? "image/png" : /\.jpe?g$/.test(url) ? "image/jpeg" : "image/webp" })), url).toBe(true)
      }
    }
  })

  it.each(["/blog/_generated/not-a-hash-480.webp", "/blog/_generated/0123456789abcdef-0.webp", "/blog/_generated/0123456789abcdef-480.png", "/blog/_generated/0123456789abcdef-480.webp.map"])("excludes unknown generated image forms: %s", path => {
    expect(publicRuntimeAssetKind(path)).toBeUndefined()
    expect(isPublicAssetPath(path)).toBe(false)
  })
  it.each([
    ["/blog-static/_next/static/chunks/blog.js", "code"],
    ["/blog-static/_next/static/chunks/blog.css", "code"],
    ["/blog-static/_next/static/media/font.woff2", "fonts"],
    ["/blog/example-article/hero.webp", "images"],
    [script, undefined],
    ["/blog/example-article", undefined],
  ])("separates Blog runtime classes from Main precache and document paths: %s", (path, kind) => {
    expect(publicRuntimeAssetKind(path!)).toBe(kind)
  })
  it.each([
    ["/contact/gus-photo.jpeg", "image/jpeg"],
    ["/landing/people/alex.webp", "image/webp"],
    ["/landing/people/lin.webp", "image/webp"],
    ["/landing/people/nina.webp", "image/webp"],
    ["/landing/people/priya.webp", "image/webp"],
    ["/landing/people/sam.webp", "image/webp"],
    ["/fonts/jgs5/jgs5.ttf", "font/ttf"],
    ["/social/readme-card-58c75311e5ba.png", "image/png"],
    ["/manifest.json", "application/manifest+json"],
    ["/manifest.json", "application/json"],
    ["/favicon.ico", "image/x-icon"],
    ["/favicon.ico", "image/vnd.microsoft.icon"],
    ["/_next/static/media/portrait.abc123.webp", "image/webp"],
    ["/_next/static/media/font.abc123.ttf", "font/ttf"],
    ["/_next/static/media/pdf.worker.min.35m0adryw15hm.mjs", "application/javascript"],
    ["/_next/static/media/pdf.worker.min.35m0adryw15hm.mjs", "text/javascript"],
    ["/_next/static/PGQscKRC0WsRFC5mS4zSH/_buildManifest.js", "application/javascript"],
    ["/_next/static/PGQscKRC0WsRFC5mS4zSH/_clientMiddlewareManifest.js", "application/javascript"],
    ["/_next/static/PGQscKRC0WsRFC5mS4zSH/_ssgManifest.js", "application/javascript"],
  ])("caches an explicitly public resource with its real MIME: %s", (path, type) => {
    expect(isPublicAssetRequest(request(path), origin)).toBe(true)
    expect(isPublicAssetResponse(request(path), response({ "Content-Type": type }))).toBe(true)
    expect(isPublicAssetResponse(request(path), response({ "Content-Type": "text/html" }))).toBe(false)
    expect(isPublicAssetResponse(request(path), response({ "Content-Type": type, "Cache-Control": "private, max-age=300" }))).toBe(false)
  })

  it.each([
    ["/blog-static/_next/static/chunks/blog-abc.js", "application/javascript"],
    ["/blog-static/_next/static/chunks/blog-abc.css", "text/css"],
    ["/blog-static/_next/static/6IhY41v62o9J7c32DmjH3/_buildManifest.js", "application/javascript"],
    ["/blog-static/_next/static/6IhY41v62o9J7c32DmjH3/_clientMiddlewareManifest.js", "text/javascript"],
    ["/blog-static/_next/static/6IhY41v62o9J7c32DmjH3/_ssgManifest.js", "application/javascript"],
    ["/blog-static/_next/static/media/font-abc.woff2", "font/woff2"],
    ["/blog-static/_next/static/media/font-abc.ttf", "font/ttf"],
    ["/blog/example-article/hero.webp", "image/webp"],
    ["/blog/example-article/timeline.svg", "image/svg+xml"],
    ["/blog/example-article/photo.jpeg", "image/jpeg"],
    ["/blog/example-article/hero.png", "image/png"],
  ])("admits a public Blog resource while rejecting its query, RSC and private variants: %s", (path, type) => {
    expect(isPublicAssetRequest(request(path), origin)).toBe(true)
    if (path.endsWith("Manifest.js")) {
      expect(publicRuntimeAssetKind(path)).toBe("code")
      for (const headers of [{ Authorization: "fixture" }, { Cookie: "fixture" }, { RSC: "1" }, { "Next-Router-State-Tree": "[]" }, { "Next-Router-Prefetch": "1" }, { Accept: "text/x-component" }] as HeadersInit[]) expect(isPublicAssetRequest(request(path, { headers }), origin)).toBe(false)
      for (const query of ["?download=one", "?favicon.abc123.ico", "?__WB_REVISION__=one"]) expect(isPublicAssetRequest(request(`${path}${query}`), origin)).toBe(false)
      for (const method of ["POST", "HEAD"]) expect(isPublicAssetRequest(request(path, { method }), origin)).toBe(false)
      const navigation = request(path)
      Object.defineProperty(navigation, "mode", { value: "navigate" })
      expect(isPublicAssetRequest(navigation, origin)).toBe(false)
      const document = request(path)
      Object.defineProperty(document, "destination", { value: "document" })
      expect(isPublicAssetRequest(document, origin)).toBe(false)
      expect(isPublicAssetResponse(request(path), response({ "Content-Type": "application/json" }))).toBe(false)
      expect(isPublicAssetResponse(request(path), response({ "Content-Type": type, "Cache-Control": "public, no-store" }))).toBe(false)
    }
    expect(isPublicAssetRequest(request(`${path}?_rsc=one`), origin)).toBe(false)
    expect(isPublicAssetRequest(request(path, { headers: { RSC: "1" } }), origin)).toBe(false)
    expect(isPublicAssetRequest(request(`https://another.test${path}`), origin)).toBe(false)
    expect(isPublicAssetResponse(request(path), response({ "Content-Type": type }))).toBe(true)
    expect(isPublicAssetResponse(request(path), response({ "Content-Type": type, "Cache-Control": "private" }))).toBe(false)
    expect(isPublicAssetResponse(request(path), response({ "Content-Type": "text/html" }))).toBe(false)
  })

  it.each([
    "/blog", "/blog/example-article", "/blog/example-article/", "/blog/example-article/index.html",
    "/blog/example-article/data.json", "/blog/example-article/source/hero.png", "/blog/private/attachment/file.png",
    "/blog-static/_next/static/chunks/blog.js.map", "/blog-static/_next/static/chunks/private.json",
    "/blog-static/_next/image", "/blog-static/fonts/server-only.ttf", "/blog-static/_next/static/media/unknown.bin",
    "/blog-static/_next/static/_buildManifest.js", "/blog-static/_next/static/build/unknown.js",
    "/blog-static/_next/static/build/nested/_buildManifest.js", "/blog-static/_next/static/build/_buildManifest.js.map",
    "/blog-static/_next/static/build/_buildmanifest.js", "/blog-static/_next/static/build/_ssgManifest.json",
  ])("excludes Blog documents, source-only images and unknown static types: %s", path => {
    expect(isPublicAssetPath(path)).toBe(false)
    expect(isPublicAssetRequest(request(path), origin)).toBe(false)
    expect(isPublicAssetResponse(request(path), response())).toBe(false)
  })

  it.each([script, "/_next/static/chunks/styles123.css", "/_next/static/media/font123.woff2", "/alook.svg", "/official-server-badge-flat.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png"])("allows a public asset: %s", path => {
    expect(isPublicAssetPath(path)).toBe(true)
    expect(isPublicAssetRequest(request(path), origin)).toBe(true)
  })

  it.each(["/c", "/c/channels/server/channel", "/sign-in", "/api/community/servers/icon", "/api/community/files/attachment", "/api/auth/get-session", "/_next/image", "/_next/static/chunks/code.js.map", "/_next/static/chunks/data.json", "/_next/static/media/unknown.mjs", "/_next/static/media/other.worker.min.35m0adryw15hm.mjs", "/_next/static/media/pdf.worker.min.mjs", "/_next/static/chunks/pdf.worker.min.35m0adryw15hm.mjs", "/attachments/pdf.worker.min.35m0adryw15hm.mjs", "/landing/unknown.svg", "/landing/people/unknown.webp", "/contact/private.jpeg", "/fonts/dm-sans-600.ttf", "/fonts/jgs5/LICENSE.txt", "/analytics-events.html", "/unknown.json", "/unknown.png", "/serwist/sw.js", "/sw.js"])("excludes private and unknown paths: %s", path => {
    expect(isPublicAssetPath(path)).toBe(false)
    expect(isPublicAssetRequest(request(path), origin)).toBe(false)
    expect(isPublicAssetResponse(request(path), response())).toBe(false)
  })

  it.each<Record<string, string>>([
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

  it.each<Record<string, string>>([
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
    expect(isPublicAssetResponse(request(), Response.error())).toBe(false)
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
