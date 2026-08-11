import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import {
  createRouterTestContext,
  loadRouter,
  getSharedMocks,
  type RouterHandler,
  type RouterTestContext,
} from "./routes/test-harness"

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

  describe("root contract", () => {
    it("exports exactly the two Durable Object classes and the default fetch handler", async () => {
      const routerModule = await import("./index")

      expect(Object.keys(routerModule).sort()).toEqual([
        "RateLimitDurableObject",
        "WebSocketDurableObject",
        "default",
      ])
      expect(Object.keys(routerModule.default)).toEqual(["fetch"])
    })

    it("falls through a known path with the wrong method to the websocket/default routing", async () => {
      doMock.stubFetch.mockResolvedValue(new Response("fallback"))
      const req = new Request("http://localhost/rate-limit/check?userId=user-fallback", {
        method: "GET",
      })

      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("user:user-fallback")
      expect(doMock.stubFetch).toHaveBeenCalledWith(req)
      expect(await res.text()).toBe("fallback")
    })

    it("keeps every old handler in order and places strict community routes before generic user routes", () => {
      const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
      const orderedHandlers = [...source.matchAll(/response = await (handle\w+)\(context\)/g)]
        .map((match) => match[1])

      expect(orderedHandlers).toEqual([
        "handleDaemonBroadcast",
        "handleCommunityUserBroadcast",
        "handleCommunityUsersBroadcast",
        "handleUserBroadcast",
        "handleUsersBroadcast",
        "handleAuditBroadcast",
        "handleBatchPresence",
        "handleSinglePresence",
        "handleMachinePush",
        "handleMachineWake",
        "handleMachineReset",
        "handleMachineBatchReset",
        "handleMachineModelSwitch",
        "handleMachineProviderSwitch",
        "handleMachineNap",
        "handleMachineForceClose",
      ])
    })

    it("sends a wrong-method bulk path through the existing upgrade fallback", async () => {
      doMock.stubFetch.mockResolvedValue(new Response("fallback"))
      const req = new Request("http://localhost/broadcast/users?userId=user-fallback", {
        method: "GET",
      })

      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("user:user-fallback")
      expect(doMock.stubFetch).toHaveBeenCalledWith(req)
      expect(await res.text()).toBe("fallback")
    })
  })
})
