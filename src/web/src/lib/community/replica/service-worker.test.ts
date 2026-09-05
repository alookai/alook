import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

type WorkerListener = (event: Record<string, unknown>) => void

class MemoryCache {
  entries = new Map<string, Response>()

  async put(input: string | { url: string }, response: Response) {
    this.entries.set(typeof input === "string" ? input : input.url, response.clone())
  }

  async match(input: string | { url: string }) {
    return this.entries.get(typeof input === "string" ? input : input.url)?.clone()
  }

  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }))
  }

  async delete(input: string | { url: string }) {
    return this.entries.delete(typeof input === "string" ? input : input.url)
  }
}

function loadWorker(fetch: ReturnType<typeof vi.fn>) {
  const listeners = new Map<string, WorkerListener>()
  const cache = new MemoryCache()
  const self = {
    location: { origin: "https://alook.test" },
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    addEventListener: (type: string, listener: WorkerListener) => listeners.set(type, listener),
  }
  const caches = { open: vi.fn().mockResolvedValue(cache) }
  const source = readFileSync(new URL("../../../../public/sw.js", import.meta.url), "utf8")
  runInNewContext(source, {
    self,
    caches,
    fetch,
    URL,
    Response,
    Error,
    Promise,
    Set,
  })
  return { cache, listeners }
}

async function dispatchMessage(
  listener: WorkerListener,
  data: Record<string, unknown>,
) {
  let work = Promise.resolve()
  let reply: unknown
  listener({
    data,
    ports: [{ postMessage: (value: unknown) => { reply = value } }],
    waitUntil: (value: Promise<unknown>) => { work = value.then(() => undefined) },
  })
  await work
  return reply
}

describe("community service worker", () => {
  it("publishes a route only after every same-origin shell asset is cached", async () => {
    const fetch = vi.fn(async (input: string | { url: string }) => {
      const url = typeof input === "string" ? input : input.url
      if (url === "https://alook.test/c/channels/s/c") {
        return new Response([
          '<script src="/_next/static/chunks/a.js"></script>',
          '<link href="/_next/static/css/a.css" rel="stylesheet">',
          '<a href="/api/community/servers">private</a>',
          '<script src="https://outside.test/x.js"></script>',
        ].join(""), { headers: { "content-type": "text/html" } })
      }
      return new Response(url, { headers: { "content-type": "application/octet-stream" } })
    })
    const worker = loadWorker(fetch)

    const reply = await dispatchMessage(worker.listeners.get("message")!, {
      type: "CACHE_COMMUNITY_ROUTE",
      protocolVersion: 1,
      url: "https://alook.test/c/channels/s/c?from=inbox#latest",
    })

    expect(reply).toEqual({
      ok: true,
      protocolVersion: 1,
      route: "https://alook.test/c/channels/s/c",
      assets: 2,
    })
    expect(worker.cache.entries.has("https://alook.test/c/channels/s/c")).toBe(true)
    expect(worker.cache.entries.has("https://alook.test/_next/static/chunks/a.js")).toBe(true)
    expect(worker.cache.entries.has("https://alook.test/_next/static/css/a.css")).toBe(true)
    expect(fetch).not.toHaveBeenCalledWith("https://alook.test/api/community/servers", expect.anything())
    expect(fetch).not.toHaveBeenCalledWith("https://outside.test/x.js", expect.anything())
  })

  it("keeps the last complete route document when a refresh asset fails", async () => {
    const fetch = vi.fn(async (input: string | { url: string }) => {
      const url = typeof input === "string" ? input : input.url
      if (url === "https://alook.test/c/me") {
        return new Response('<script src="/_next/static/chunks/missing.js"></script>', {
          headers: { "content-type": "text/html" },
        })
      }
      return new Response("missing", { status: 503 })
    })
    const worker = loadWorker(fetch)
    await worker.cache.put("https://alook.test/c/me", new Response("old-complete-shell"))

    const reply = await dispatchMessage(worker.listeners.get("message")!, {
      type: "CACHE_COMMUNITY_ROUTE",
      protocolVersion: 1,
      url: "https://alook.test/c/me",
    })

    expect(reply).toEqual({ ok: false, error: "asset-unavailable" })
    await expect((await worker.cache.match("https://alook.test/c/me"))!.text()).resolves.toBe("old-complete-shell")
  })

  it("serves a covered navigation locally and never intercepts API or RSC fetches", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"))
    const worker = loadWorker(fetch)
    await worker.cache.put("https://alook.test/c/channels/s/c", new Response("local-shell"))
    const fetchListener = worker.listeners.get("fetch")!
    let responsePromise: Promise<Response> | undefined
    const waitUntil = vi.fn()

    fetchListener({
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://alook.test/c/channels/s/c?_tracking=1",
        headers: new Headers(),
      },
      respondWith: (value: Promise<Response>) => { responsePromise = value },
      waitUntil,
    })
    await expect((await responsePromise!)!.text()).resolves.toBe("local-shell")
    expect(waitUntil).toHaveBeenCalledTimes(1)

    const apiRespond = vi.fn()
    fetchListener({
      request: { method: "GET", mode: "cors", url: "https://alook.test/api/community/servers", headers: new Headers() },
      respondWith: apiRespond,
      waitUntil: vi.fn(),
    })
    fetchListener({
      request: { method: "GET", mode: "cors", url: "https://alook.test/c/me?_rsc=abc", headers: new Headers() },
      respondWith: apiRespond,
      waitUntil: vi.fn(),
    })
    expect(apiRespond).not.toHaveBeenCalled()
  })
})
