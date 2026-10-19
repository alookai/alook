// @vitest-environment jsdom
import * as fakeIndexedDB from "fake-indexeddb"
import { CacheExpiration, CacheFirst, ExpirationPlugin, NetworkFirst, Strategy, type RuntimeCaching } from "serwist"
import { afterEach, describe, expect, it, vi } from "vitest"
import { publicWorkerRuntimeCacheNames } from "./cache-identity"
import { createPublicRuntimeCaching, type PublicRuntimeLimits } from "./public-cache-runtime"

const origin = "https://alook.test"
const code = "/blog-static/_next/static/chunks/article-a.js"
const font = "/blog-static/_next/static/media/font-a.woff2"
const image = "/blog/example-article/hero.webp"
const artificialLimits: PublicRuntimeLimits = {
  code: { maxEntries: 2, maxAgeSeconds: 60 },
  fonts: { maxEntries: 2, maxAgeSeconds: 60 },
  images: { maxEntries: 2, maxAgeSeconds: 60 },
}

class WorkerFetchEvent extends Event {
  readonly pending: Promise<unknown>[] = []
  #request: Request
  constructor(request: Request) { super("fetch"); this.#request = request }
  get request() { return this.#request }
  waitUntil(promise: Promise<unknown>) { this.pending.push(promise) }
}

const urlOf = (request: RequestInfo | URL) => typeof request === "string" ? new URL(request, origin).href : request instanceof URL ? request.href : request.url
const request = (path: string, init?: RequestInit) => new Request(new URL(path, origin), init)
const response = (body: string, type = "application/javascript", headers?: Record<string, string>, status = 200) => new Response(body, {
  status, headers: { "Content-Type": type, "Cache-Control": "public, max-age=300", Date: new Date(Date.now()).toUTCString(), ...headers },
})

function fixture() {
  for (const [name, value] of Object.entries(fakeIndexedDB)) if (name.startsWith("IDB")) vi.stubGlobal(name, value)
  vi.stubGlobal("indexedDB", new fakeIndexedDB.IDBFactory())
  vi.stubGlobal("ExtendableEvent", WorkerFetchEvent)
  vi.stubGlobal("FetchEvent", WorkerFetchEvent)
  vi.stubGlobal("__WB_DISABLE_DEV_LOGS", true)
  const entries = new Map<string, Map<string, Response>>()
  const operations: Array<{ operation: string; cache: string; url: string; date: string | null }> = []
  vi.stubGlobal("caches", {
    match: async (key: RequestInfo, options: MultiCacheQueryOptions) => entries.get(options.cacheName!)?.get(urlOf(key))?.clone(),
    open: async (name: string) => {
      if (!entries.has(name)) entries.set(name, new Map())
      const stored = entries.get(name)!
      return {
        match: async (key: RequestInfo) => stored.get(urlOf(key))?.clone(),
        put: async (key: RequestInfo, value: Response) => {
          operations.push({ operation: "put", cache: name, url: urlOf(key), date: value.headers.get("Date") })
          stored.set(urlOf(key), value.clone())
        },
        delete: async (key: RequestInfo) => {
          operations.push({ operation: "delete", cache: name, url: urlOf(key), date: stored.get(urlOf(key))?.headers.get("Date") ?? null })
          return stored.delete(urlOf(key))
        },
        keys: async () => [...stored.keys()].map(url => new Request(url)),
      }
    },
  })
  const network = vi.fn<typeof fetch>(async () => response("first"))
  vi.stubGlobal("fetch", network)
  const routes = createPublicRuntimeCaching(origin, artificialLimits)
  const strategy = (kind: keyof PublicRuntimeLimits) => {
    const handler = routes.find(route => route.handler instanceof Strategy && route.handler.cacheName === publicWorkerRuntimeCacheNames()[kind])?.handler
    if (!(handler instanceof Strategy)) throw new Error(`Missing runtime strategy: ${kind}`)
    return handler
  }
  return { entries, network, routes, strategy, operations }
}

function matches(routes: RuntimeCaching[], req: Request) {
  const event = new WorkerFetchEvent(req) as unknown as FetchEvent
  return routes.filter(route => typeof route.matcher === "function" && route.matcher({ request: req, url: new URL(req.url), sameOrigin: new URL(req.url).origin === origin, event }))
}

async function read(strategy: Strategy, path: string) {
  const req = request(path)
  const event = new WorkerFetchEvent(req)
  const results = await Promise.allSettled(strategy.handleAll({ request: req, event: event as unknown as FetchEvent }))
  const lifetime = await Promise.allSettled(event.pending)
  for (const result of [...results, ...lifetime]) if (result.status === "rejected") throw result.reason
  return (results[0] as PromiseFulfilledResult<Response>).value
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe("official public runtime strategies with artificial limits", () => {
  it.each([
    ["code", "maxEntries", 0], ["fonts", "maxEntries", -1], ["images", "maxEntries", 1.5],
    ["code", "maxEntries", Number.POSITIVE_INFINITY], ["fonts", "maxEntries", Number.NaN], ["images", "maxEntries", Number.MAX_SAFE_INTEGER + 1],
    ["code", "maxAgeSeconds", 0], ["fonts", "maxAgeSeconds", -1], ["images", "maxAgeSeconds", Number.POSITIVE_INFINITY], ["code", "maxAgeSeconds", Number.NaN],
  ] as const)("requires a bounded positive runtime policy: %s %s %s", (kind, field, value) => {
    fixture()
    const limits = { ...artificialLimits, [kind]: { ...artificialLimits[kind], [field]: value } }
    expect(() => createPublicRuntimeCaching(origin, limits)).toThrow(RangeError)
  })
  it("routes each public Blog type once while leaving Main assets to precache", () => {
    const { routes, strategy } = fixture()
    expect(strategy("code")).toBeInstanceOf(CacheFirst)
    expect(strategy("fonts")).toBeInstanceOf(CacheFirst)
    expect(strategy("images")).toBeInstanceOf(NetworkFirst)
    for (const path of [code, font, image]) expect(matches(routes, request(path))).toHaveLength(1)
    for (const path of ["/_next/static/chunks/main.js", "/favicon.ico", "/blog", "/blog/example-article", "/blog/example-article/source/hero.png", "/api/auth/get-session", `${code}?_rsc=one`]) {
      expect(matches(routes, request(path))).toHaveLength(0)
    }
    expect(matches(routes, request(`https://other.test${code}`))).toHaveLength(0)
    expect(matches(routes, request(code, { method: "POST" }))).toHaveLength(0)
    const sensitiveHeaders: HeadersInit[] = [{ Authorization: "fixture" }, { Cookie: "fixture" }, { RSC: "1" }, { "Next-Router-State-Tree": "[]" }, { Accept: "text/x-component" }]
    for (const headers of sensitiveHeaders) {
      expect(matches(routes, request(code, { headers }))).toHaveLength(0)
    }
    const navigation = request(code)
    Object.defineProperty(navigation, "mode", { value: "navigate" })
    expect(matches(routes, navigation)).toHaveLength(0)
  })

  it.each([["code", code, "application/javascript"], ["fonts", font, "font/woff2"]] as const)("serves a warmed fingerprinted %s URL without another network request", async (kind, path, type) => {
    const { strategy, network } = fixture()
    network.mockImplementation(async () => response("first", type))
    expect(await (await read(strategy(kind), path)).text()).toBe("first")
    network.mockImplementation(async () => response("changed", type))
    expect(await (await read(strategy(kind), path)).text()).toBe("first")
    expect(network).toHaveBeenCalledTimes(1)
    const [, options] = network.mock.calls[0]
    expect(options).toMatchObject({ credentials: "omit", redirect: "error" })
  })

  it("revalidates a non-fingerprinted image at the same URL and falls back to its last public bytes offline", async () => {
    const { strategy, network, entries } = fixture()
    network.mockImplementationOnce(async () => response("first image", "image/webp"))
    expect(await (await read(strategy("images"), image)).text()).toBe("first image")
    network.mockImplementationOnce(async () => response("new image", "image/webp"))
    expect(await (await read(strategy("images"), image)).text()).toBe("new image")
    expect(await entries.get(publicWorkerRuntimeCacheNames().images)?.get(new URL(image, origin).href)?.clone().text()).toBe("new image")
    network.mockRejectedValueOnce(new TypeError("offline"))
    expect(await (await read(strategy("images"), image)).text()).toBe("new image")
    expect(network).toHaveBeenCalledTimes(3)
    for (const [, options] of network.mock.calls) expect(options).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-cache" })
  })

  it.each(["_buildManifest.js", "_clientMiddlewareManifest.js", "_ssgManifest.js"])("persists the actual public Blog helper %s in its CacheFirst code cache", async name => {
    const { routes, strategy, network, entries } = fixture()
    const path = `/blog-static/_next/static/6IhY41v62o9J7c32DmjH3/${name}`
    expect(matches(routes, request(path))).toHaveLength(1)
    const handler = strategy("code")
    expect(handler).toBeInstanceOf(CacheFirst)
    expect(handler.cacheName).toBe(publicWorkerRuntimeCacheNames().code)
    network.mockImplementationOnce(async () => response(`public ${name}`))
    expect(await (await read(handler, path)).text()).toBe(`public ${name}`)
    expect(await entries.get(handler.cacheName)?.get(new URL(path, origin).href)?.clone().text()).toBe(`public ${name}`)
    network.mockRejectedValueOnce(new TypeError("offline"))
    expect(await (await read(handler, path)).text()).toBe(`public ${name}`)
    expect(network).toHaveBeenCalledTimes(1)
  })

  it.each(["_buildManifest.js", "_clientMiddlewareManifest.js", "_ssgManifest.js"])("does not retain an HTML response at the public Blog helper %s URL", async name => {
    const { strategy, network, entries } = fixture()
    const path = `/blog-static/_next/static/6IhY41v62o9J7c32DmjH3/${name}`
    network.mockImplementationOnce(async () => response("HTML", "text/html"))
    expect(await (await read(strategy("code"), path)).text()).toBe("HTML")
    expect(entries.get(publicWorkerRuntimeCacheNames().code)?.has(new URL(path, origin).href) ?? false).toBe(false)
    network.mockRejectedValueOnce(new TypeError("offline"))
    await expect(read(strategy("code"), path)).rejects.toThrow()
  })

  it.each([
    ["private", () => response("private", "image/webp", { "Cache-Control": "private" })],
    ["no-store", () => response("private", "image/webp", { "Cache-Control": "public, no-store" })],
    ["html", () => response("HTML", "text/html")],
    ["RSC", () => response("RSC", "text/x-component")],
    ["404", () => response("missing", "image/webp", undefined, 404)],
    ["opaque", () => {
      const opaque = response("opaque", "image/webp")
      Object.defineProperties(opaque, { status: { value: 0 }, type: { value: "opaque" } })
      opaque.clone = () => opaque
      return opaque
    }],
  ] as const)("does not persist a %s network response through NetworkFirst's default permissive path", async (_name, makeResponse) => {
    const { strategy, network, entries } = fixture()
    network.mockImplementationOnce(async () => makeResponse())
    await read(strategy("images"), image)
    expect(entries.get(publicWorkerRuntimeCacheNames().images)?.size ?? 0).toBe(0)
    network.mockRejectedValueOnce(new TypeError("offline"))
    await expect(read(strategy("images"), image)).rejects.toThrow()
  })

  it("evicts the oldest entry at an artificial entry limit without evicting another runtime class", async () => {
    const { strategy, network, entries } = fixture()
    let now = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => now)
    network.mockImplementation(async input => response("public", urlOf(input).endsWith("woff2") ? "font/woff2" : "application/javascript"))
    await read(strategy("fonts"), font)
    for (const suffix of ["a", "b", "c"]) {
      now += 1000
      await read(strategy("code"), `/blog-static/_next/static/chunks/${suffix}.js`)
    }
    expect([...entries.get(publicWorkerRuntimeCacheNames().code)!.keys()]).toEqual(["b", "c"].map(suffix => `${origin}/blog-static/_next/static/chunks/${suffix}.js`))
    expect(entries.get(publicWorkerRuntimeCacheNames().fonts)?.has(new URL(font, origin).href)).toBe(true)
  })

  it("rejects an aged cached response and fetches new bytes under an artificial age limit", async () => {
    const { strategy, network, entries, operations } = fixture()
    let now = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => now)
    network.mockImplementationOnce(async () => response("old font", "font/woff2"))
    expect(await (await read(strategy("fonts"), font)).text()).toBe("old font")
    now += 61_000
    network.mockImplementationOnce(async () => response("new font", "font/woff2"))
    expect(await (await read(strategy("fonts"), font)).text()).toBe("new font")
    expect(network).toHaveBeenCalledTimes(2)
    expect(await entries.get(publicWorkerRuntimeCacheNames().fonts)?.get(new URL(font, origin).href)?.clone().text(), JSON.stringify(operations)).toBe("new font")
  })

  it("does not return an aged cached font when its network request also fails", async () => {
    const { strategy, network, entries } = fixture()
    let now = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => now)
    network.mockImplementationOnce(async () => response("old font", "font/woff2"))
    await read(strategy("fonts"), font)
    now += 61_000
    network.mockRejectedValueOnce(new TypeError("offline"))
    await expect(read(strategy("fonts"), font)).rejects.toThrow()
    expect(entries.get(publicWorkerRuntimeCacheNames().fonts)?.has(new URL(font, origin).href)).toBe(false)
  })

  it("finishes the scheduled stale scan before fetching and storing replacement bytes", async () => {
    const { strategy, network, entries, operations } = fixture()
    let now = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => now)
    network.mockImplementationOnce(async () => response("old font", "font/woff2"))
    await read(strategy("fonts"), font)
    now += 61_000
    const staleCleanupStarted = Promise.withResolvers<void>()
    const releaseStaleCleanup = Promise.withResolvers<void>()
    const originalExpire = CacheExpiration.prototype.expireEntries
    let staleCleanupScheduled = false
    let staleCleanupFinished = false
    vi.spyOn(CacheExpiration.prototype, "expireEntries").mockImplementation(async function (this: CacheExpiration) {
      if (!staleCleanupScheduled) {
        staleCleanupScheduled = true
        staleCleanupStarted.resolve()
        await releaseStaleCleanup.promise
        await originalExpire.call(this)
        staleCleanupFinished = true
      } else await originalExpire.call(this)
    })
    let networkStartedAfterCleanup = false
    network.mockImplementationOnce(async () => {
      networkStartedAfterCleanup = staleCleanupFinished
      return response("new font", "font/woff2")
    })
    const refreshed = read(strategy("fonts"), font)
    await staleCleanupStarted.promise
    releaseStaleCleanup.resolve()
    expect(await (await refreshed).text()).toBe("new font")
    expect(networkStartedAfterCleanup).toBe(true)
    expect(network).toHaveBeenCalledTimes(2)
    expect(await entries.get(publicWorkerRuntimeCacheNames().fonts)?.get(new URL(font, origin).href)?.clone().text(), JSON.stringify(operations)).toBe("new font")
  })

  it("still fetches fresh bytes when stale cleanup rejects and preserves the event failure", async () => {
    const { strategy, network, entries } = fixture()
    let now = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => now)
    network.mockImplementationOnce(async () => response("old font", "font/woff2"))
    await read(strategy("fonts"), font)
    now += 61_000
    const cleanupFailure = new Error("expiry storage unavailable")
    vi.spyOn(CacheExpiration.prototype, "expireEntries").mockRejectedValueOnce(cleanupFailure)
    network.mockImplementationOnce(async () => response("new font", "font/woff2"))
    const req = request(font)
    const event = new WorkerFetchEvent(req)
    const results = await Promise.allSettled(strategy("fonts").handleAll({ request: req, event: event as unknown as FetchEvent }))
    const lifetime = await Promise.allSettled(event.pending)
    expect(results[0].status).toBe("fulfilled")
    if (results[0].status !== "fulfilled") throw results[0].reason
    expect(await results[0].value.text()).toBe("new font")
    expect(network).toHaveBeenCalledTimes(2)
    expect(await entries.get(publicWorkerRuntimeCacheNames().fonts)?.get(req.url)?.clone().text()).toBe("new font")
    expect(lifetime).toContainEqual({ status: "rejected", reason: cleanupFailure })
  })

  it("preserves the native request getter when the SDK handles a rejected waitUntil registration", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const { strategy, network, entries } = fixture()
    let now = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => now)
    network.mockImplementationOnce(async () => response("old font", "font/woff2"))
    await read(strategy("fonts"), font)
    now += 61_000
    network.mockImplementationOnce(async () => response("new font", "font/woff2"))
    const req = request(font)
    const event = new WorkerFetchEvent(req)
    const requestGetter = vi.spyOn(event, "request", "get")
    const originalCachedResponseWillBeUsed = ExpirationPlugin.prototype.cachedResponseWillBeUsed
    let callbackRequestReads = 0
    vi.spyOn(ExpirationPlugin.prototype, "cachedResponseWillBeUsed").mockImplementation(function (this: ExpirationPlugin, options) {
      const before = requestGetter.mock.calls.length
      const result = originalCachedResponseWillBeUsed.call(this, options)
      callbackRequestReads += requestGetter.mock.calls.length - before
      return result
    })
    const originalWaitUntil = event.waitUntil.bind(event)
    let registrations = 0
    vi.spyOn(event, "waitUntil").mockImplementation(promise => {
      if (++registrations === 2) {
        throw new DOMException("event lifetime already closed", "InvalidStateError")
      }
      originalWaitUntil(promise)
    })
    const results = await Promise.allSettled(strategy("fonts").handleAll({ request: req, event: event as unknown as FetchEvent }))
    const lifetime = await Promise.allSettled(event.pending)
    for (const result of [...results, ...lifetime]) if (result.status === "rejected") throw result.reason
    expect(callbackRequestReads).toBe(1)
    expect(registrations).toBe(2)
    expect(await (results[0] as PromiseFulfilledResult<Response>).value.text()).toBe("new font")
    expect(network).toHaveBeenCalledTimes(2)
    expect(await entries.get(publicWorkerRuntimeCacheNames().fonts)?.get(req.url)?.clone().text()).toBe("new font")
  })
})
