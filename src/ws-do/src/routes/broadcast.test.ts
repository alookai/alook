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

  describe("broadcast route", () => {
    it("preserves daemon routing, trace logging, streamed body, and the internal response", async () => {
      doMock.stubFetch.mockResolvedValue(new Response("daemon-ok", {
        status: 202,
        headers: { "x-broadcast": "accepted" },
      }))
      const req = new Request("http://localhost/broadcast/daemon/daemon-42", {
        method: "POST",
        headers: { "X-Trace-Id": "trace-9" },
        body: "stream-me",
      })

      const res = await handler.fetch(req, env as any)

      expect(loggerMocks.child).toHaveBeenCalledWith({ traceId: "trace-9", daemonId: "daemon-42" })
      expect(loggerMocks.debug).toHaveBeenCalledWith("broadcasting to daemon")
      expect(doMock.idFromName).toHaveBeenCalledWith("daemon:daemon-42")
      expect(doMock.get).toHaveBeenCalledWith("mock-do-id")
      const internal = doMock.stubFetch.mock.calls[0][0] as Request
      expect(internal.url).toBe("http://internal/broadcast")
      expect(internal.method).toBe("POST")
      expect(await internal.text()).toBe("stream-me")
      expect(res.status).toBe(202)
      expect(res.headers.get("x-broadcast")).toBe("accepted")
      expect(await res.text()).toBe("daemon-ok")
    })

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
})
