import { describe, expect, it, vi } from "vitest"
import { createWebWorkerHandler } from "./worker-runtime"

function createRuntime(response: Response) {
  const openNextFetch = vi.fn(async () => response)
  const wsFetch = vi.fn(async () => new Response("ws-do"))
  const handler = createWebWorkerHandler({ fetch: openNextFetch })
  const env = { WS_DO_WORKER: { fetch: wsFetch } } as unknown as CloudflareEnv
  const ctx = {} as ExecutionContext
  return {
    openNextFetch,
    wsFetch,
    fetch: (request: Request) => handler.fetch!(request, env, ctx),
  }
}

describe("Web Worker runtime seam", () => {
  it.each(["/api/ws", "/api/ws/socket"])(
    "forwards WebSocket upgrades on %s to the ws-do service binding",
    async (pathname) => {
      const runtime = createRuntime(new Response("open-next"))
      const request = new Request(`https://worker.test${pathname}`, {
        headers: { Upgrade: "WebSocket" },
      })

      const response = await runtime.fetch(request)

      expect(await response.text()).toBe("ws-do")
      expect(runtime.wsFetch).toHaveBeenCalledWith(request)
      expect(runtime.openNextFetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    ["plain token request", "/api/ws/token", undefined],
    ["upgrade outside the ws route", "/socket", { Upgrade: "websocket" }],
  ])("keeps %s in the OpenNext path", async (_name, pathname, headers) => {
    const runtime = createRuntime(new Response("open-next"))
    const request = new Request(`https://worker.test${pathname}`, { headers })

    const response = await runtime.fetch(request)

    expect(await response.text()).toBe("open-next")
    expect(runtime.openNextFetch).toHaveBeenCalledWith(request, expect.anything(), expect.anything())
    expect(runtime.wsFetch).not.toHaveBeenCalled()
  })

  it.each(["/w/one", "/workspaces", "/dashboard/one", "/invite/one", "/api/one", "/_next/one"])(
    "does not add public cache headers to private route %s",
    async (pathname) => {
      const original = new Response("private", { status: 200 })
      const runtime = createRuntime(original)

      const response = await runtime.fetch(new Request(`https://worker.test${pathname}`))

      expect(response).toBe(original)
      expect(response.headers.get("Cache-Control")).toBeNull()
      expect(response.headers.get("CDN-Cache-Control")).toBeNull()
    },
  )

  it.each(["/", "/pricing", "/apiary"])(
    "adds browser and CDN revalidation headers to public route %s",
    async (pathname) => {
      const original = new Response("public", {
        status: 200,
        headers: { "x-open-next": "preserved" },
      })
      const runtime = createRuntime(original)

      const response = await runtime.fetch(new Request(`https://worker.test${pathname}`))

      expect(response).not.toBe(original)
      expect(await response.text()).toBe("public")
      expect(response.headers.get("x-open-next")).toBe("preserved")
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate")
      expect(response.headers.get("CDN-Cache-Control")).toBe(
        "public, s-maxage=3600, stale-while-revalidate=86400",
      )
    },
  )

  it("returns a non-200 public response unchanged", async () => {
    const original = new Response("missing", { status: 404 })
    const runtime = createRuntime(original)

    const response = await runtime.fetch(new Request("https://worker.test/missing"))

    expect(response).toBe(original)
    expect(response.headers.get("Cache-Control")).toBeNull()
    expect(response.headers.get("CDN-Cache-Control")).toBeNull()
  })
})
