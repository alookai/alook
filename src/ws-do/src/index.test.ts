import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMockDONamespace } from "./__mocks__/cf"

// Mock ws-durable so the router import doesn't pull in cloudflare:workers
vi.mock("./ws-durable", () => ({
  WebSocketDurableObject: class {},
}))

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
        body: JSON.stringify({ type: "runtime.status", runtimeId: "r1", status: "online" }),
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
})
