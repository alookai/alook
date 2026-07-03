import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMockDONamespace } from "./__mocks__/cf"

// Mock ws-durable so the router import doesn't pull in cloudflare:workers
vi.mock("./ws-durable", () => ({
  WebSocketDurableObject: class {},
}))

const mockFindActiveCredential = vi.fn()

vi.mock("@alook/shared", () => {
  const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child(){ return this } }
  return {
    createDb: () => ({}),
    createLogger: () => noopLogger,
    queries: {
      communityMachine: {
        findActiveCredentialByBearer: (...a: unknown[]) => mockFindActiveCredential(...a),
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
      mockFindActiveCredential.mockReset()
    })

    it("resolves credential to machineId and routes to community-machine:<machineId> DO", async () => {
      mockFindActiveCredential.mockResolvedValue({
        credentialId: "cmk_abc",
        userId: "u_1",
        machineId: "cm_xyz",
      })
      doMock.stubFetch.mockResolvedValue(new Response(null, { status: 200 }))
      const req = new Request("http://localhost/", {
        headers: { Upgrade: "websocket", Authorization: "Bearer cmk_abc" },
      })
      const res = await handler.fetch(req, env as any)
      expect(mockFindActiveCredential).toHaveBeenCalledWith(expect.anything(), "cmk_abc")
      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:cm_xyz")
      // 200 comes back from our stubbed DO — the real path returns 101.
      expect(res.status).toBe(200)
    })

    it("returns 401 when the credential is unknown or revoked", async () => {
      mockFindActiveCredential.mockResolvedValue(null)
      const req = new Request("http://localhost/", {
        headers: { Upgrade: "websocket", Authorization: "Bearer cmk_bad" },
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(401)
      expect(doMock.get).not.toHaveBeenCalled()
    })

    it("returns 426 for legacy ?token=cmt_ requests (upgrade CLI)", async () => {
      const req = new Request("http://localhost/?token=cmt_legacy", {
        headers: { Upgrade: "websocket" },
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(426)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/upgrade the alook CLI/i)
      expect(doMock.get).not.toHaveBeenCalled()
    })
  })

  describe("force-close routing", () => {
    it("keys the DO by machineId", async () => {
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ closed: 1 })))
      const req = new Request("http://localhost/community-machine/cm_abc/force-close", {
        method: "POST",
      })
      await handler.fetch(req, env as any)
      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:cm_abc")
    })
  })
})
