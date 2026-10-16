import { afterEach, describe, expect, it, vi } from "vitest"
import { CacheFirst, NetworkFirst, Serwist, Strategy } from "serwist"
import { publicWorkerRuntimeCacheNames } from "../lib/service-worker/cache-identity"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

describe("public worker activation", () => {
  it("registers actual Blog strategies while keeping precache and sensitive request boundaries", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const listeners = vi.spyOn(Serwist.prototype, "addEventListeners")
    const location = new URL("https://example.test/sw.js")
    vi.stubGlobal("location", location)
    vi.stubGlobal("self", { location, __SW_MANIFEST: [{ url: "/icon-192.png", revision: "fixture" }, { url: "/favicon.ico", revision: "fixture-favicon" }, { url: "/_next/static/chunks/example.js", revision: "fixture-code" }], registration: { scope: `${location.origin}/` }, addEventListener: vi.fn() })
    await import("./sw")
    const serwist = listeners.mock.contexts[0]
    if (!(serwist instanceof Serwist)) throw new Error("Missing actual Serwist instance")
    const matched = (path: string, init?: RequestInit) => {
      const url = new URL(path, location)
      const request = new Request(url, init)
      return serwist.findMatchingRoute({ url, request, sameOrigin: url.origin === location.origin, event: new Event("fetch") as FetchEvent })
    }
    const match = (path: string, init?: RequestInit) => matched(path, init).route?.handler
    const names = publicWorkerRuntimeCacheNames()
    for (const [path, kind, StrategyClass] of [
      ["/blog-static/_next/static/chunks/article.js", "code", CacheFirst],
      ["/blog-static/_next/static/chunks/article.css", "code", CacheFirst],
      ["/blog-static/_next/static/6IhY41v62o9J7c32DmjH3/_buildManifest.js", "code", CacheFirst],
      ["/blog-static/_next/static/6IhY41v62o9J7c32DmjH3/_clientMiddlewareManifest.js", "code", CacheFirst],
      ["/blog-static/_next/static/6IhY41v62o9J7c32DmjH3/_ssgManifest.js", "code", CacheFirst],
      ["/blog-static/_next/static/media/font.woff2", "fonts", CacheFirst],
      ["/blog/_generated/0123456789abcdef-480.webp", "images", NetworkFirst],
      ["/blog/example-article/hero.webp", "images", NetworkFirst],
    ] as const) {
      const handler = match(path)
      expect(handler, path).toBeInstanceOf(StrategyClass)
      expect((handler as Strategy).cacheName, path).toBe(names[kind])
      expect(match(path, { headers: { Authorization: "fixture" } }), path).toBeUndefined()
      expect(match(`${path}?_rsc=fixture`), path).toBeUndefined()
    }
    expect(match("/icon-192.png")).toBe(serwist.precacheStrategy)
    for (const path of ["/favicon.ico?favicon.227o87hfvs4zs.ico", "/favicon.ico?favicon.abc123.ico"]) {
      const result = matched(path)
      expect(result.route?.handler, path).toBe(serwist.precacheStrategy)
      expect(result.params, path).toEqual(expect.objectContaining({ cacheKey: serwist.getPrecacheKeyForUrl("/favicon.ico") }))
      expect(match(path, { headers: { RSC: "1" } })).toBeUndefined()
    }
    for (const path of ["/favicon.ico?favicon.abc123.ico=", "/favicon.ico?favicon.abc123.ico&x=1", "/favicon.ico?%66avicon.abc123.ico", "/favicon.ico?__WB_REVISION__=fixture", "/_next/static/chunks/example.js?favicon.abc123.ico"]) expect(match(path), path).toBeUndefined()
    expect(match("/icon-192.png", { headers: { Cookie: "fixture" } })).toBeUndefined()
    for (const path of ["/api/auth/get-session", "/blog", "/blog/example-article", "/c/me", "https://other.test/blog/example-article/hero.webp"]) expect(match(path), path).toBeUndefined()
  })
  it("runs actual Serwist activation and deletes old custom cache names without changing the current cache", async () => {
    const names = new Set(["alook-public-precache-v0", "alook-public-precache-v1", "alook-public-v99-runtime", "unrelated-cache"])
    const storage = { keys: vi.fn(async () => [...names]), delete: vi.fn(async (name: string) => names.delete(name)),
      open: vi.fn(async (name: string) => { names.add(name); return { keys: async () => [] as Request[] } }) }
    const listeners = new Map<string, Array<(event: { waitUntil: (promise: Promise<unknown>) => void }) => unknown>>()
    const location = new URL("https://example.test/sw.js")
    const worker = { __SW_MANIFEST: [], location, caches: storage, registration: { scope: "https://example.test/" }, clients: { claim: vi.fn(async () => undefined) },
      addEventListener: (type: string, listener: (event: { waitUntil: (promise: Promise<unknown>) => void }) => unknown) => listeners.set(type, [...listeners.get(type) ?? [], listener]) }
    vi.stubGlobal("self", worker)
    vi.stubGlobal("location", location)
    vi.stubGlobal("caches", storage)
    await import("./sw")
    const pending: Promise<unknown>[] = []
    for (const listener of listeners.get("activate") ?? []) listener({ waitUntil: promise => { pending.push(promise) } })
    await Promise.all(pending)
    expect(worker.clients.claim).toHaveBeenCalledOnce()
    expect(names).toEqual(new Set(["alook-public-precache-v1", "unrelated-cache"]))
    expect(storage.delete.mock.calls.map(([name]) => name)).toEqual(["alook-public-precache-v0", "alook-public-v99-runtime"])
    expect(storage.open).toHaveBeenCalledWith("alook-public-precache-v1")
    expect(listeners.has("fetch")).toBe(true)
  })
})
