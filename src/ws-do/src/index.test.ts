import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMockDONamespace } from "./__mocks__/cf"

// Mock ws-durable / rate-limit-do so the router import doesn't pull in cloudflare:workers
vi.mock("./ws-durable", () => ({
  WebSocketDurableObject: class { },
}))
vi.mock("./rate-limit-do", () => ({
  RateLimitDurableObject: class { },
}))

const mockHashCredential = vi.fn(async (bearer: string) => `sha256:${bearer}`)
const mockDoNameFromHash = vi.fn((hash: string) => hash.slice(0, 32))
const mockGetActiveDoNamesForMachine = vi.fn(async (_db: unknown, _machineId: string) => [] as string[])

vi.mock("@alook/shared", () => {
  const noopLogger = { debug: () => { }, info: () => { }, warn: () => { }, error: () => { }, child() { return this } }
  return {
    createDb: () => ({}),
    createLogger: () => noopLogger,
    queries: {
      communityMachine: {
        hashCredential: (bearer: string) => mockHashCredential(bearer),
        doNameFromHash: (hash: string) => mockDoNameFromHash(hash),
        getActiveDoNamesForMachine: (db: unknown, machineId: string) => mockGetActiveDoNamesForMachine(db, machineId),
      },
    },
  }
})

import handler from "./index"

describe("ws-do router", () => {
  let doMock: ReturnType<typeof createMockDONamespace>
  let env: { WS_DO: DurableObjectNamespace }

  beforeEach(() => {
    vi.clearAllMocks()
    doMock = createMockDONamespace()
    env = { WS_DO: doMock.namespace } as unknown as { WS_DO: DurableObjectNamespace }
  })

  describe("broadcast route", () => {
    it("forwards POST /broadcast/user/:userId to correct DO instance", async () => {
      doMock.stubFetch.mockResolvedValue(new Response("ok"))
      const req = new Request("http://localhost/broadcast/user/user-123", {
        method: "POST",
        body: JSON.stringify({ type: "runtime.status", daemonId: "d1", workspaceId: "w1", status: "online" }),
      })

      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("user:user-123")
      expect(doMock.get).toHaveBeenCalledWith("mock-do-id")
      expect(doMock.stubFetch).toHaveBeenCalled()
      const stubReq = doMock.stubFetch.mock.calls[0][0] as Request
      expect(stubReq.url).toBe("http://internal/broadcast")
      expect(stubReq.method).toBe("POST")
      expect(res.status).toBe(200)
    })
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

      const urls = doMock.stubFetch.mock.calls.map(([r]: [Request]) => r.url)
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

  describe("WebSocket route", () => {
    it("forwards GET with userId param to DO instance", async () => {
      doMock.stubFetch.mockResolvedValue(new Response(null, { status: 200 }))
      const req = new Request("http://localhost/?userId=user-456", {
        headers: { Upgrade: "websocket" },
      })

      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("user:user-456")
      expect(doMock.get).toHaveBeenCalledWith("mock-do-id")
      expect(doMock.stubFetch).toHaveBeenCalledWith(req)
    })

    it("returns 400 when userId is missing", async () => {
      const req = new Request("http://localhost/", {
        headers: { Upgrade: "websocket" },
      })

      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(400)
      expect(await res.text()).toBe("userId required")
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })
  })

  describe("community-machine Bearer auth", () => {
    beforeEach(() => {
      mockHashCredential.mockClear()
      mockDoNameFromHash.mockClear()
    })

    it("names DO from sha256(bearer).slice(0,32) with zero D1 reads", async () => {
      mockHashCredential.mockResolvedValue("0".repeat(32) + "1".repeat(32))
      mockDoNameFromHash.mockReturnValue("0".repeat(32))
      doMock.stubFetch.mockResolvedValue(new Response(null, { status: 200 }))
      const req = new Request("http://localhost/", {
        headers: { Upgrade: "websocket", Authorization: "Bearer cmk_abc" },
      })
      const res = await handler.fetch(req, env as any)
      expect(mockHashCredential).toHaveBeenCalledWith("cmk_abc")
      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:" + "0".repeat(32))
      expect(res.status).toBe(200)
    })

    it("returns 400 for legacy ?token=cmt_ requests (no 426, no body)", async () => {
      const req = new Request("http://localhost/?token=cmt_legacy", {
        headers: { Upgrade: "websocket" },
      })
      const res = await handler.fetch(req, env as any)
      // The 426 legacy branch was deleted; the request falls through to the
      // "no userId" branch, which 400s.
      expect(res.status).toBe(400)
      expect(doMock.get).not.toHaveBeenCalled()
    })

    it("routes missing Authorization without cmk_ to the default handler (no auth path)", async () => {
      const req = new Request("http://localhost/", {
        headers: { Upgrade: "websocket" },
      })
      const res = await handler.fetch(req, env as any)
      // No userId → 400 (existing default). We assert we do NOT hit the
      // credential-hash path or touch a DO under community-machine:*.
      expect(mockHashCredential).not.toHaveBeenCalled()
      expect(res.status).toBe(400)
    })
  })

  describe("POST /community-machine/by-id/:machineId/forward-agent-wake", () => {
    beforeEach(() => {
      mockGetActiveDoNamesForMachine.mockReset()
      mockGetActiveDoNamesForMachine.mockResolvedValue([])
    })

    it("zero active doNames → { sent: 0 } without touching any DO", async () => {
      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(mockGetActiveDoNamesForMachine).toHaveBeenCalledWith({}, "machine-1")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("single active doName, daemon connected → forwards and aggregates sent count", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-abc"])
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "agent:wake", agentId: "bot-1" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:do-abc")
      const stubReq = doMock.stubFetch.mock.calls[0][0] as Request
      expect(stubReq.url).toBe("http://internal/forward-agent-wake")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 1 })
    })

    it("daemon offline (DO reports { sent: 0 }) → does not count as delivered", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-abc"])
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 0 }), { status: 200 }))

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
    })

    it("multi-doName fan-out: both DOs hit, aggregate sums delivered counts", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"])
      let call = 0
      doMock.stubFetch.mockImplementation(() => {
        call++
        const sent = call === 1 ? 0 : 1
        return Promise.resolve(new Response(JSON.stringify({ sent }), { status: 200 }))
      })

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:do-a")
      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:do-b")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 1 })
    })

    it("DO fetch throws — tolerated, other doNames still evaluated", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"])
      let call = 0
      doMock.stubFetch.mockImplementation(() => {
        call++
        if (call === 1) return Promise.reject(new Error("network error"))
        return Promise.resolve(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
      })

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 1 })
    })

    it("DO fetch throws with no delivery → retryable 503", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a"])
      doMock.stubFetch.mockRejectedValue(new Error("network error"))

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "failed to forward agent wake" })
    })

    it("non-2xx or malformed DO responses with no delivery → retryable 503", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"])
      let call = 0
      doMock.stubFetch.mockImplementation(() => {
        call++
        if (call === 1) return Promise.resolve(new Response("oops", { status: 502 }))
        return Promise.resolve(new Response(JSON.stringify({ sent: "bad" }), { status: 200 }))
      })

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "failed to forward agent wake" })
    })

    it("DB lookup failure → retryable 503, not offline { sent: 0 }", async () => {
      mockGetActiveDoNamesForMachine.mockRejectedValue(new Error("d1 unreachable"))

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "failed to resolve machine" })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })
  })

  describe("force-close routing", () => {
    it("keys the DO by the do_name suffix", async () => {
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ closed: 1 })))
      const doName = "a".repeat(32)
      const req = new Request(`http://localhost/community-machine/${doName}/force-close`, {
        method: "POST",
      })
      await handler.fetch(req, env as any)
      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:" + doName)
    })
  })
})
