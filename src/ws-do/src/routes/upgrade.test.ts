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

  describe("WebSocket route", () => {
    it("prioritizes community-machine Bearer auth over daemonId and userId", async () => {
      mockHashCredential.mockResolvedValue("f".repeat(64))
      mockDoNameFromHash.mockReturnValue("f".repeat(32))
      doMock.stubFetch.mockResolvedValue(new Response(null, { status: 200 }))
      const req = new Request("http://localhost/?daemonId=daemon-1&userId=user-1", {
        headers: { Upgrade: "websocket", Authorization: "Bearer cmk_priority" },
      })

      const res = await handler.fetch(req, env as any)

      expect(mockHashCredential).toHaveBeenCalledWith("cmk_priority")
      expect(doMock.idFromName).toHaveBeenCalledTimes(1)
      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:" + "f".repeat(32))
      expect(doMock.stubFetch).toHaveBeenCalledWith(req)
      expect(res.status).toBe(200)
    })

    it("prioritizes daemonId over userId when no community-machine bearer is present", async () => {
      doMock.stubFetch.mockResolvedValue(new Response(null, { status: 200 }))
      const req = new Request("http://localhost/?daemonId=daemon-1&userId=user-1", {
        headers: { Upgrade: "websocket" },
      })

      const res = await handler.fetch(req, env as any)

      expect(mockHashCredential).not.toHaveBeenCalled()
      expect(doMock.idFromName).toHaveBeenCalledTimes(1)
      expect(doMock.idFromName).toHaveBeenCalledWith("daemon:daemon-1")
      expect(doMock.stubFetch).toHaveBeenCalledWith(req)
      expect(res.status).toBe(200)
    })

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
})
