import { afterEach, describe, expect, it, vi } from "vitest"
import { CacheFirst, PrecacheStrategy } from "serwist"
import { createPublicWorkerScriptResponsePlugin } from "./worker-script-response"

const origin = "https://alook.test"
const path = "/_next/static/chunks/worker.js"
const scriptUrl = `${origin}${path}`
const body = "postMessage(self.location.href)"
const headers = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" }

function request(destination: RequestDestination = "worker", init?: RequestInit, url = `${scriptUrl}#fixture=config`) {
  const value = new Request(url, init)
  Object.defineProperty(value, "destination", { value: destination })
  return value
}

function response(url = scriptUrl, init?: ResponseInit) {
  const value = new Response(body, { headers, ...init })
  Object.defineProperty(value, "url", { value: url })
  return value
}

const respond = (req: Request, res: Response) => createPublicWorkerScriptResponsePlugin(origin).handlerWillRespond!({ request: req, response: res, event: new Event("fetch") as FetchEvent })

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe("public Worker script response URL boundary", () => {
  it.each(["worker", "sharedworker"] as const)("keeps original script bytes and headers while leaving %s location to the request", async destination => {
    const source = response()
    const result = await respond(request(destination), source)
    expect(result).not.toBe(source)
    expect(result.url).toBe("")
    expect(result.status).toBe(source.status)
    expect(result.statusText).toBe(source.statusText)
    expect([...result.headers]).toEqual([...source.headers])
    expect(await result.text()).toBe(body)
  })

  it("leaves other destinations, sensitive requests and unqualified responses untouched", async () => {
    for (const destination of ["", "script", "style", "document", "serviceworker"] as const) {
      const source = response()
      expect(await respond(request(destination), source)).toBe(source)
    }
    for (const init of [{ headers: { Authorization: "fixture" } }, { headers: { Cookie: "fixture" } }, { headers: { RSC: "1" } }, { method: "POST" }]) {
      const source = response()
      expect(await respond(request("worker", init), source)).toBe(source)
    }
    for (const url of [`${scriptUrl}?version=fixture`, `https://other.test${path}`, `${origin}/api/private.js`]) {
      const source = response()
      expect(await respond(request("worker", undefined, url), source)).toBe(source)
    }
    for (const source of [response(""), response(`https://other.test${path}`), response(`${origin}/_next/static/chunks/other.js`), response(scriptUrl, { status: 404 }), response(scriptUrl, { headers: { ...headers, "Cache-Control": "private, no-store" } }), response(scriptUrl, { headers: { ...headers, "Content-Type": "text/html" } }), response(scriptUrl, { headers: { ...headers, Vary: "Cookie" } }), response(scriptUrl, { headers: { ...headers, "Set-Cookie": "fixture=private" } }), Response.error()]) {
      expect(await respond(request(), source)).toBe(source)
    }
    const redirected = response()
    Object.defineProperty(redirected, "redirected", { value: true })
    expect(await respond(request(), redirected)).toBe(redirected)
  })

  it.each(["precache-hit", "runtime-hit", "runtime-miss"] as const)("uses the official final-response hook for %s without changing cache identity", async scenario => {
    class WorkerEvent extends Event {
      pending: Promise<unknown>[] = []
      readonly request: Request
      constructor(request: Request) { super("fetch"); this.request = request }
      waitUntil(promise: Promise<unknown>) { this.pending.push(promise) }
    }
    vi.stubEnv("NODE_ENV", "production")
    vi.stubGlobal("ExtendableEvent", WorkerEvent)
    vi.stubGlobal("FetchEvent", WorkerEvent)
    const location = new URL(`${origin}/sw.js`)
    vi.stubGlobal("location", location)
    const source = response()
    const match = vi.fn<(key: RequestInfo | URL, options?: CacheQueryOptions) => Promise<Response | undefined>>(async () => scenario === "runtime-miss" ? undefined : source)
    const put = vi.fn<(key: RequestInfo | URL, value: Response) => Promise<void>>(async () => undefined)
    const storage = { match, open: async () => ({ match, put }) }
    vi.stubGlobal("caches", storage)
    vi.stubGlobal("self", { location, caches: storage, registration: { scope: `${origin}/` } })
    const network = vi.fn<typeof fetch>(async () => source)
    vi.stubGlobal("fetch", network)
    const plugins = [createPublicWorkerScriptResponsePlugin(origin)]
    const strategy = scenario === "precache-hit" ? new PrecacheStrategy({ cacheName: "fixture-public", plugins }) : new CacheFirst({ cacheName: "fixture-public", plugins })
    const req = request()
    const event = new WorkerEvent(req)
    const [result, done] = strategy.handleAll({ request: req, event: event as unknown as FetchEvent })
    const output = await result
    await done
    await Promise.all(event.pending)
    expect(output.url).toBe("")
    expect([...output.headers]).toEqual([...source.headers])
    expect(await output.text()).toBe(body)
    expect(source.url).toBe(scriptUrl)
    expect(network).toHaveBeenCalledTimes(scenario === "runtime-miss" ? 1 : 0)
    expect(put).toHaveBeenCalledTimes(scenario === "runtime-miss" ? 1 : 0)
    expect(match.mock.calls[0][0]).toMatchObject({ url: req.url })
    if (scenario === "runtime-miss") expect(await (put.mock.calls[0][1] as Response).text()).toBe(body)
  })
})
