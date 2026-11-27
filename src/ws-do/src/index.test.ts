import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
    it("exports exactly the three Durable Object classes and the default fetch handler", async () => {
      const routerModule = await import("./index")

      expect(Object.keys(routerModule).sort()).toEqual([
        "OwnerScheduleDurableObject",
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

    it("disables workers.dev and preview URLs in wrangler.toml", () => {
      const config = readFileSync(resolve(import.meta.dirname, "../wrangler.toml"), "utf8")
      expect(config).toContain("workers_dev = false")
      expect(config).toContain("preview_urls = false")
    })

    it.each([
      "/owner-schedule/%E0%A4%A/sync-alarm",
      "/community-machine/by-id/%E0%A4%A/push",
      "/community-machine/by-id/%E0%A4%A/forward-agent-wake",
      "/community-machine/by-id/%E0%A4%A/forward-diagnostics-collect",
      "/community-machine/by-id/%E0%A4%A/forward-stop",
      "/community-machine/by-id/%E0%A4%A/forward-agent-reset",
      "/community-machine/by-id/%E0%A4%A/forward-batch-reset",
      "/community-machine/by-id/%E0%A4%A/forward-agent-nap",
      "/community-machine/%E0%A4%A/force-close",
      "/community-machine/by-id/%E0%A4%A/discover-models",
      "/community-machine/by-id/%E0%A4%A/pii",
      "/community-machine/by-id/%E0%A4%A/forward-agent-model-switch",
      "/community-machine/by-id/%E0%A4%A/forward-agent-provider-switch",
      "/community-machine/by-id/%E0%A4%A/forward-agent-runtime-config-update",
    ])("returns 400 instead of 500/503 for malformed percent encoding on %s", async (pathname) => {
      const res = await handler.fetch(new Request(`http://localhost${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }), env as any)
      expect(res.status).toBe(400)
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })
  })
})
