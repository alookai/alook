import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PrecacheEntry, Route, Serwist } from "serwist"

type WorkerOptions = ConstructorParameters<typeof Serwist>[0]

const boundary = vi.hoisted(() => ({
  options: [] as WorkerOptions[],
  routes: [] as Route[],
  match: vi.fn(),
  listeners: vi.fn(),
}))

vi.mock("serwist", async importOriginal => {
  const actual = await importOriginal<typeof import("serwist")>()
  return {
    ...actual,
    Serwist: class {
      routes: Map<"GET", Route[]>

      constructor(options: WorkerOptions) {
        const route = new actual.Route(boundary.match, async () => new Response("public bytes"))
        this.routes = new Map([["GET", [route]]])
        boundary.options.push(options)
        boundary.routes.push(route)
      }

      addEventListeners() {
        boundary.listeners(this.routes)
      }
    },
  }
})

const origin = "https://alook.ai"
const asset = "/_next/static/chunks/public-a.js"
const manifest: PrecacheEntry[] = [{ url: asset, revision: "revision-a" }]
const params = { cacheKey: `${origin}${asset}?__SW_REVISION__=revision-a` }
const request = (path = asset, init?: RequestInit) => new Request(new URL(path, origin), init)
const event = () => new Event("fetch") as FetchEvent
const matchOptions = (req: Request) => ({ request: req, url: new URL(req.url), sameOrigin: new URL(req.url).origin === origin, event: event() })
const response = (headers?: HeadersInit, status = 200) => new Response("public bytes", {
  status,
  headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "application/javascript", ...headers },
})

async function loadWorker(entries: PrecacheEntry[] | undefined = manifest) {
  vi.stubGlobal("self", { __SW_MANIFEST: entries, location: { origin } })
  await import("./sw")
  expect(boundary.options).toHaveLength(1)
  expect(boundary.routes).toHaveLength(1)
  return { options: boundary.options[0], route: boundary.routes[0] }
}

describe("public service worker entry", () => {
  beforeEach(() => {
    vi.resetModules()
    boundary.options.length = 0
    boundary.routes.length = 0
    boundary.match.mockReset().mockReturnValue(params)
    boundary.listeners.mockReset()
  })

  afterEach(() => vi.unstubAllGlobals())

  it("hands the injected manifest to the public precache without broad runtime caching", async () => {
    const { options } = await loadWorker()
    expect(options.precacheEntries).toBe(manifest)
    expect(options).toMatchObject({
      cacheId: "alook-public-v1",
      clientsClaim: true,
      precacheOptions: {
        cacheName: "alook-public-precache-v1",
        cleanURLs: false,
        directoryIndex: null,
        ignoreURLParametersMatching: [],
      },
    })
    expect(options.precacheOptions?.plugins).toHaveLength(1)
    expect(options).not.toHaveProperty("runtimeCaching")
    expect(options).not.toHaveProperty("skipWaiting")
  })

  it("does not invent a manifest when injection is absent", async () => {
    vi.stubGlobal("self", { __SW_MANIFEST: undefined, location: { origin } })
    await import("./sw")
    expect(boundary.options[0].precacheEntries).toBeUndefined()
  })

  it("installs the request guard before attaching listeners and preserves revision parameters", async () => {
    boundary.listeners.mockImplementation((routes: Map<"GET", Route[]>) => {
      const route = routes.get("GET")![0]
      expect(route.match(matchOptions(request(asset, { headers: { Authorization: "test" } })))).toBe(false)
      expect(route.match(matchOptions(request()))).toBe(params)
    })
    const { route } = await loadWorker()
    expect(boundary.listeners).toHaveBeenCalledOnce()
    expect(boundary.match).toHaveBeenCalledOnce()
    expect(route.match(matchOptions(request()))).toBe(params)
  })

  it("rejects private, RSC, credential, navigation, write, query and cross-origin requests", async () => {
    const { route } = await loadWorker()
    const navigation = request()
    Object.defineProperty(navigation, "mode", { value: "navigate" })
    const document = request()
    Object.defineProperty(document, "destination", { value: "document" })
    const rejected = [
      request("/api/auth/get-session"),
      request("/c"),
      request(asset, { headers: { RSC: "1" } }),
      request(asset, { headers: { Cookie: "session=test" } }),
      request(asset, { headers: { Authorization: "test" } }),
      request(asset, { method: "POST" }),
      request(`${asset}?_rsc=account`),
      request(`https://other.example${asset}`),
      navigation,
      document,
    ]
    for (const req of rejected) expect(route.match(matchOptions(req))).toBe(false)
    expect(boundary.match).not.toHaveBeenCalled()
  })

  it("downloads public precache assets anonymously and rejects redirects", async () => {
    const { options } = await loadWorker()
    const original = request(asset, { credentials: "include", redirect: "follow" })
    const plugin = options.precacheOptions!.plugins![0]
    const anonymous = await plugin.requestWillFetch!({ request: original, event: event() })
    expect(anonymous).not.toBe(original)
    expect(anonymous.url).toBe(original.url)
    expect(anonymous.method).toBe("GET")
    expect(anonymous.credentials).toBe("omit")
    expect(anonymous.redirect).toBe("error")
    expect(original.credentials).toBe("include")
    expect(original.redirect).toBe("follow")
  })

  it("writes only explicitly public asset responses through the installed plugin", async () => {
    const { options } = await loadWorker()
    const plugin = options.precacheOptions!.plugins![0]
    const publicResponse = response()
    expect(await plugin.cacheWillUpdate!({ request: request(), response: publicResponse, event: event() })).toBe(publicResponse)
    const rejected = [
      response({ "Cache-Control": "private, max-age=600" }),
      response({ "Cache-Control": "public, no-store" }),
      response({ "Set-Cookie": "session=test" }),
      response({ Vary: "Cookie" }),
      response({ "Content-Type": "text/html" }),
      response({ "Content-Type": "text/x-component" }),
      response({}, 404),
    ]
    const redirected = response()
    Object.defineProperty(redirected, "redirected", { value: true })
    rejected.push(redirected)
    for (const res of rejected) {
      expect(await plugin.cacheWillUpdate!({ request: request(), response: res, event: event() })).toBeNull()
    }
    expect(await plugin.cacheWillUpdate!({ request: request("/api/community/files/attachment"), response: publicResponse, event: event() })).toBeNull()
  })
})
