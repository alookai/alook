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
