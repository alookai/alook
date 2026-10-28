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
    vi.stubGlobal("self", { skipWaiting: vi.fn(async () => undefined), location, __SW_MANIFEST: [{ url: shellUrl, revision: "fixture-shell" }, { url: "/icon-192.png", revision: "fixture" }, { url: "/favicon.ico", revision: "fixture-favicon" }, { url: "/_next/static/chunks/example.js", revision: "fixture-code" }], registration: { scope: `${location.origin}/` }, addEventListener: vi.fn() })
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
    vi.stubGlobal("self", { skipWaiting: vi.fn(async () => undefined), location, caches: storage, registration: { scope: `${location.origin}/` }, addEventListener: vi.fn(),
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
  it.each([true, false])("runs actual Serwist activation and claims only with the current cached shell: %s", async available => {
    const html = '<main data-community-shell="public">Application</main>'
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html))
    const path = `/community-shell/${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`
    const stored = new Map<string, Response>()
    const names = new Set(["alook-public-precache-v0", "alook-public-precache-v1", "alook-public-v99-runtime", "unrelated-cache"])
    const storage = { keys: vi.fn(async () => [...names]), delete: vi.fn(async (name: string) => names.delete(name)),
      open: vi.fn(async (name: string) => { names.add(name); return { keys: async () => [] as Request[], match: async (key: string) => stored.get(key)?.clone() } }) }
    const added = vi.spyOn(Serwist.prototype, "addEventListeners")
    const listeners = new Map<string, Array<(event: { waitUntil: (promise: Promise<unknown>) => void }) => unknown>>()
    const location = new URL("https://example.test/sw.js")
    const worker = { skipWaiting: vi.fn(async () => undefined), __SW_MANIFEST: [{ url: path, revision: null }], location, caches: storage, registration: { scope: "https://example.test/" }, clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async () => []) },
      addEventListener: (type: string, listener: (event: { waitUntil: (promise: Promise<unknown>) => void }) => unknown) => listeners.set(type, [...listeners.get(type) ?? [], listener]) }
    vi.stubGlobal("self", worker)
    vi.stubGlobal("location", location)
    vi.stubGlobal("caches", storage)
    await import("./sw")
    const serwist = added.mock.contexts[0]
    if (!(serwist instanceof Serwist)) throw new Error("Missing actual Serwist instance")
    if (available) stored.set(serwist.getPrecacheKeyForUrl(path)!, new Response(html, { headers: { "Content-Type": "text/html" } }))
    const pending: Promise<unknown>[] = []
    for (const listener of listeners.get("activate") ?? []) listener({ waitUntil: promise => { pending.push(promise) } })
    if (available) await Promise.all(pending)
    else await expect(Promise.all(pending)).rejects.toThrow("Current community shell unavailable")
    expect(worker.clients.claim).toHaveBeenCalledTimes(available ? 1 : 0)
    expect(names).toEqual(new Set(["alook-public-precache-v1", "unrelated-cache"]))
    expect(storage.delete.mock.calls.map(([name]) => name)).toEqual(["alook-public-precache-v0", "alook-public-v99-runtime"])
    expect(storage.open).toHaveBeenCalledWith("alook-public-precache-v1")
    expect(listeners.has("fetch")).toBe(true)
  })
})

it.each(["probe", "probe-no-port", "unrelated", "missing-source", "source-without-id", "wrong-version", "missing-shell", "missing-client", "public-client", "current-marker", "navigate", "retry-marker", "navigation-refused"])("handles the actual worker message lifecycle: %s", async scenario => {
  const { BUSINESS_SCHEMA_VERSION } = await import("@alook/shared/business-schema-version")
  const { CURRENT_DOCUMENT_REQUEST, WORKER_VERSION_PROBE } = await import("../lib/service-worker/business-upgrade")
  const location = new URL("https://example.test/sw.js")
  const match = vi.spyOn(Serwist.prototype, "matchPrecache").mockResolvedValue(scenario === "missing-shell" ? undefined : new Response("cached current shell"))
  const handlers: Array<(event: MessageEvent & { waitUntil: (value: Promise<unknown>) => void }) => void> = []
  const marker = scenario === "current-marker" || scenario === "retry-marker" ? `?__alook_schema_update=${BUSINESS_SCHEMA_VERSION}` : ""
  const client = { id: "document", url: `https://example.test/${scenario === "public-client" ? "blog" : "c/me"}${marker}`, navigate: vi.fn(async () => scenario === "navigation-refused" ? null : ({ id: "new-document" })), postMessage: vi.fn() }
  const clients = { matchAll: vi.fn(async () => scenario === "missing-client" ? [] : [client]), claim: vi.fn() }
  vi.stubGlobal("location", location)
  vi.stubGlobal("self", { location, skipWaiting: vi.fn(async () => undefined), registration: { scope: "https://example.test/" }, clients, __SW_MANIFEST: [{ url: shellUrl, revision: null }], addEventListener: (type: string, handler: typeof handlers[number]) => { if (type === "message") handlers.push(handler) } })
  await import("./sw")
  const reply = vi.fn()
  const pending: Promise<unknown>[] = []
  const data = { type: scenario.startsWith("probe") ? WORKER_VERSION_PROBE : scenario === "unrelated" ? "unrelated" : CURRENT_DOCUMENT_REQUEST, schemaVersion: scenario === "wrong-version" ? BUSINESS_SCHEMA_VERSION - 1 : BUSINESS_SCHEMA_VERSION, explicitRetry: scenario === "retry-marker" }
  const source = scenario === "missing-source" ? null : scenario === "source-without-id" ? {} : { id: "document" }
  handlers.at(-1)!({ data, source, ports: scenario === "probe-no-port" ? [] : [{ postMessage: reply }], waitUntil: promise => { pending.push(promise) } } as never)
  await Promise.all(pending)
  if (scenario.startsWith("probe")) {
    expect(pending).toHaveLength(0)
    if (scenario === "probe") expect(reply).toHaveBeenCalledWith({ schemaVersion: BUSINESS_SCHEMA_VERSION })
    else expect(reply).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  } else if (scenario === "unrelated") {
    expect(pending).toHaveLength(0)
    expect(reply).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  } else {
    const navigates = scenario === "navigate" || scenario === "retry-marker"
    expect(reply).toHaveBeenCalledWith({ navigating: navigates })
    expect(pending).toHaveLength(1)
    expect(client.navigate).toHaveBeenCalledTimes(navigates || scenario === "navigation-refused" ? 1 : 0)
    if (navigates) expect(client.navigate).toHaveBeenCalledWith(`https://example.test/c/me?__alook_schema_update=${BUSINESS_SCHEMA_VERSION}`)
  }
})
