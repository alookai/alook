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

  describe("POST /rate-limit/check", () => {
    it("returns the exact invalid-json response", async () => {
      const res = await handler.fetch(new Request("http://localhost/rate-limit/check", {
        method: "POST",
        body: "not-json",
      }), env as any)

      expect(res.status).toBe(400)
      expect(await res.text()).toBe("invalid json")
      expect(rateLimitMock.stubFetch).not.toHaveBeenCalled()
    })

    it("requires a non-empty name", async () => {
      const res = await handler.fetch(new Request("http://localhost/rate-limit/check", {
        method: "POST",
        body: JSON.stringify({ key: "user-1", windowMs: 1_000, max: 2 }),
      }), env as any)

      expect(res.status).toBe(400)
      expect(await res.text()).toBe("name required")
      expect(rateLimitMock.stubFetch).not.toHaveBeenCalled()
    })

    it("requires a non-empty key", async () => {
      const res = await handler.fetch(new Request("http://localhost/rate-limit/check", {
        method: "POST",
        body: JSON.stringify({ name: "message", key: "", windowMs: 1_000, max: 2 }),
      }), env as any)

      expect(res.status).toBe(400)
      expect(await res.text()).toBe("key required")
      expect(rateLimitMock.stubFetch).not.toHaveBeenCalled()
    })

    it("targets the exact limiter DO and preserves the internal request contract", async () => {
      rateLimitMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ allowed: true }), {
        status: 201,
        headers: { "x-rate-limit": "ok" },
      }))
      const res = await handler.fetch(new Request("http://localhost/rate-limit/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "message", key: "user-1", windowMs: 12_345, max: 7 }),
      }), env as any)

      expect(rateLimitMock.idFromName).toHaveBeenCalledWith("message:user-1")
      expect(rateLimitMock.get).toHaveBeenCalledWith("mock-do-id")
      const internal = rateLimitMock.stubFetch.mock.calls[0][0] as Request
      expect(internal.url).toBe("http://internal/check")
      expect(internal.method).toBe("POST")
      expect(internal.headers.get("content-type")).toBe("application/json")
      expect(await internal.json()).toEqual({ windowMs: 12_345, max: 7 })
      expect(res.status).toBe(201)
      expect(res.headers.get("x-rate-limit")).toBe("ok")
      expect(await res.json()).toEqual({ allowed: true })
    })
  })
})
