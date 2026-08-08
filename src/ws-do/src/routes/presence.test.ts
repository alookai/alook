import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createRouterTestContext,
  loadRouter,
  getSharedMocks,
  type RouterHandler,
  type RouterTestContext,
} from "./test-harness"

const sharedMocks = getSharedMocks()
const mockHashCredential = sharedMocks.hashCredential
const mockDoNameFromHash = sharedMocks.doNameFromHash
const mockGetActiveDoNamesForMachine = sharedMocks.getActiveDoNamesForMachine
const loggerMocks = {
  child: sharedMocks.loggerChild,
  debug: sharedMocks.loggerDebug,
}

describe("ws-do router", () => {
  let handler: RouterHandler
  let doMock: RouterTestContext["doMock"]
  let rateLimitMock: RouterTestContext["rateLimitMock"]
  let env: RouterTestContext["env"]

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const context = createRouterTestContext()
    doMock = context.doMock
    rateLimitMock = context.rateLimitMock
    env = context.env
    handler = await loadRouter()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    vi.resetModules()
    doMock = undefined as unknown as RouterTestContext["doMock"]
    rateLimitMock = undefined as unknown as RouterTestContext["rateLimitMock"]
    env = undefined as unknown as RouterTestContext["env"]
    handler = undefined as unknown as RouterHandler
  })

  describe("POST /presence/users", () => {
    it("empty ids array short-circuits and performs zero DO fetches", async () => {
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [] }),
      })

      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ online: [] })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("returns only online ids from mixed responses", async () => {
      doMock.stubFetch.mockImplementation((req: Request) => {
        // Round-robin: we can't tell which id -- rely on call order.
        const idx = doMock.stubFetch.mock.calls.length - 1
        const online = idx % 2 === 0 // u1 online, u2 offline, u3 online
        return Promise.resolve(new Response(JSON.stringify({ online }), { status: 200 }))
      })

      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["u1", "u2", "u3"] }),
      })

      const res = await handler.fetch(req, env as any)
      const body = await res.json() as { online: string[] }

      expect(res.status).toBe(200)
      expect(body.online.sort()).toEqual(["u1", "u3"])
    })

    it("returns empty online list when all ids are offline", async () => {
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ online: false }), { status: 200 }))

      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["a", "b", "c"] }),
      })

      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ online: [] })
    })

    it("passes ?userId=<id> on every /check-user-online request — the target DO can't recover its own name from ctx (Fix 3)", async () => {
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ online: true }), { status: 200 }))

      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["bot-1", "human-2"] }),
      })

      await handler.fetch(req, env as any)

      const urls = doMock.stubFetch.mock.calls.map(([r]) => (r as Request).url)
      expect(urls).toContain("http://internal/check-user-online?userId=bot-1")
      expect(urls).toContain("http://internal/check-user-online?userId=human-2")
    })

    it("returns 400 on malformed body — missing ids", async () => {
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("returns 400 on malformed body — ids is not an array", async () => {
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: "u1" }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("returns 400 on malformed body — non-string entries", async () => {
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["u1", 42, "u3"] }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("returns 400 on invalid JSON body", async () => {
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("returns 400 when ids array exceeds cap", async () => {
      const ids = Array.from({ length: 1001 }, (_, i) => `u${i}`)
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("tolerates a per-id DO fetch throwing — other ids still evaluated", async () => {
      let call = 0
      doMock.stubFetch.mockImplementation(() => {
        call++
        if (call === 1) return Promise.reject(new Error("boom"))
        return Promise.resolve(new Response(JSON.stringify({ online: true }), { status: 200 }))
      })

      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["u1", "u2", "u3"] }),
      })
      const res = await handler.fetch(req, env as any)
      const body = await res.json() as { online: string[] }

      expect(res.status).toBe(200)
      expect(body.online.sort()).toEqual(["u2", "u3"])
    })
  })

  describe("compat: GET /presence/user/:uid", () => {
    it("still returns { online: boolean } (kept for rollout safety)", async () => {
      doMock.stubFetch.mockResolvedValue(
        new Response(JSON.stringify({ online: true }), { status: 200 })
      )
      const req = new Request("http://localhost/presence/user/user-789", { method: "GET" })
      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("user:user-789")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ online: true })
      const stubReq = doMock.stubFetch.mock.calls[0][0] as Request
      expect(stubReq.url).toBe("http://internal/check-user-online?userId=user-789")
    })
  })
})
