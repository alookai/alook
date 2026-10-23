import { afterEach, describe, expect, it, vi } from "vitest"
import { CacheFirst, NavigationRoute, NetworkFirst, Serwist, Strategy } from "serwist"
import { publicWorkerRuntimeCacheNames } from "../lib/service-worker/cache-identity"

const shellUrl = `/community-shell/${"a".repeat(64)}`

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

describe("public worker activation", () => {
  it("registers actual Blog strategies while keeping precache and sensitive request boundaries", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const listeners = vi.spyOn(Serwist.prototype, "addEventListeners")
    const location = new URL("https://example.test/sw.js")
    vi.stubGlobal("location", location)
    vi.stubGlobal("self", { location, __SW_MANIFEST: [{ url: shellUrl, revision: "fixture-shell" }, { url: "/icon-192.png", revision: "fixture" }, { url: "/favicon.ico", revision: "fixture-favicon" }, { url: "/_next/static/chunks/example.js", revision: "fixture-code" }], registration: { scope: `${location.origin}/` }, addEventListener: vi.fn() })
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
    for (const path of ["/c", "/c/me/bots", "/c/channels/server/channel?seq=4"]) {
      const url = new URL(path, location)
      const request = new Request(url, { headers: { Cookie: "fixture" } })
      Object.defineProperty(request, "mode", { value: "navigate" })
      expect(serwist.findMatchingRoute({ url, request, sameOrigin: true, event: new Event("fetch") as FetchEvent }).route).toBeInstanceOf(NavigationRoute)
    }
    expect(match(shellUrl)).toBeDefined()
    expect(match(shellUrl, { headers: { Cookie: "fixture" } })).toBeUndefined()
    expect(match("/icon-192.png", { headers: { Cookie: "fixture" } })).toBeUndefined()
    for (const path of ["/api/auth/get-session", "/blog", "/blog/example-article", "/c/me", "https://other.test/blog/example-article/hero.webp"]) expect(match(path), path).toBeUndefined()
  })
  it.each(["public", "changed-shell", "private-asset"] as const)("installs only validated public shell and asset bytes: %s", async (scenario) => {
    vi.stubEnv("NODE_ENV", "production")
    const html = '<main data-community-shell="public">Application</main>'
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html))
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
    const path = `/community-shell/${hash}`
    const location = new URL("https://example.test/sw.js")
    const stored = new Map<string, Response>()
    const urlOf = (key: RequestInfo | URL) => typeof key === "string" ? new URL(key, location).href : key instanceof URL ? key.href : key.url
    const storage = {
      match: async (key: RequestInfo | URL) => stored.get(urlOf(key))?.clone(),
      open: async () => ({
        match: async (key: RequestInfo | URL) => stored.get(urlOf(key))?.clone(),
        put: async (key: RequestInfo | URL, response: Response) => { stored.set(urlOf(key), response.clone()) },
      }),
    }
    class WorkerEvent extends Event {
      pending: Promise<unknown>[] = []
      waitUntil(promise: Promise<unknown>) { this.pending.push(promise) }
    }
    class WorkerFetchEvent extends WorkerEvent {}
    vi.stubGlobal("ExtendableEvent", WorkerEvent)
    vi.stubGlobal("FetchEvent", WorkerFetchEvent)
    vi.stubGlobal("location", location)
    vi.stubGlobal("caches", storage)
    vi.stubGlobal("self", { location, caches: storage, registration: { scope: `${location.origin}/` }, addEventListener: vi.fn(),
      __SW_MANIFEST: [{ url: path, revision: null }, { url: "/icon-192.png", revision: "fixture" }] })
    const network = vi.fn<typeof fetch>(async input => {
      const shell = new URL(urlOf(input)).pathname === path
      return new Response(shell ? scenario === "changed-shell" ? "Changed bytes" : html : "Public icon", {
        headers: { "Content-Type": shell ? "text/html" : "image/png",
          "Cache-Control": !shell && scenario === "private-asset" ? "private, no-store" : "public, max-age=31536000, immutable" },
      })
    })
    vi.stubGlobal("fetch", network)
    const listeners = vi.spyOn(Serwist.prototype, "addEventListeners")
    await import("./sw")
    const serwist = listeners.mock.contexts[0]
    if (!(serwist instanceof Serwist)) throw new Error("Missing actual Serwist instance")
    const event = new WorkerEvent("install")
    const install = serwist.handleInstall(event as Parameters<Serwist["handleInstall"]>[0])
    const results = await Promise.allSettled([install, ...event.pending])
    if (scenario === "public") {
      expect(results.every(result => result.status === "fulfilled")).toBe(true)
      expect(stored.size).toBe(2)
      expect(await stored.get(new URL(path, location).href)?.clone().text()).toBe(html)
      const iconKey = serwist.getPrecacheKeyForUrl(new URL("/icon-192.png", location).href)!
      expect(await stored.get(iconKey)?.clone().text()).toBe("Public icon")
    } else {
      expect(results.some(result => result.status === "rejected")).toBe(true)
      const rejectedPath = scenario === "changed-shell" ? path : "/icon-192.png"
      const rejectedUrl = new URL(rejectedPath, location).href
      const key = serwist.getPrecacheKeyForUrl(rejectedUrl)!
      expect(stored.has(key)).toBe(false)
      for (const result of results) if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ name: "bad-precaching-response", details: { url: rejectedUrl, status: 200 } })
      }
    }
    expect(network).toHaveBeenCalledTimes(2)
    for (const [input] of network.mock.calls) {
      expect(input).toBeInstanceOf(Request)
      expect(input).toMatchObject({ credentials: "omit", redirect: "error" })
    }
  })
  it("runs actual Serwist activation and deletes old custom cache names without changing the current cache", async () => {
    const names = new Set(["alook-public-precache-v0", "alook-public-precache-v1", "alook-public-v99-runtime", "unrelated-cache"])
    const storage = { keys: vi.fn(async () => [...names]), delete: vi.fn(async (name: string) => names.delete(name)),
      open: vi.fn(async (name: string) => { names.add(name); return { keys: async () => [] as Request[] } }) }
    const listeners = new Map<string, Array<(event: { waitUntil: (promise: Promise<unknown>) => void }) => unknown>>()
    const location = new URL("https://example.test/sw.js")
    const worker = { __SW_MANIFEST: [{ url: shellUrl, revision: "fixture-shell" }], location, caches: storage, registration: { scope: "https://example.test/" }, clients: { claim: vi.fn(async () => undefined) },
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
