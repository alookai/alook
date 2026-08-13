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

  describe("POST /community-machine/by-id/:machineId/forward-update", () => {
    beforeEach(() => {
      mockGetActiveDoNamesForMachine.mockReset().mockResolvedValue([])
    })

    it("returns sent:0 when the machine has no active credential DO", async () => {
      const response = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-update",
        { method: "POST" },
      ), env as any)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("constructs only the exact machine:update frame and aggregates live delivery", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"])
      doMock.stubFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sent: 2 }), { status: 200 }))

      const response = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-update",
        { method: "POST", body: JSON.stringify({ command: "ignored" }) },
      ), env as any)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ sent: 3 })
      expect(doMock.stubFetch).toHaveBeenCalledTimes(2)
      for (const [request] of doMock.stubFetch.mock.calls) {
        expect(await (request as Request).clone().json()).toEqual({ type: "machine:update" })
      }
    })

    it("returns 503 when resolution fails or every live DO delivery is transiently inconclusive", async () => {
      mockGetActiveDoNamesForMachine.mockRejectedValueOnce(new Error("D1 down"))
      const resolutionFailure = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-update",
        { method: "POST" },
      ), env as any)
      expect(resolutionFailure.status).toBe(503)

      mockGetActiveDoNamesForMachine.mockResolvedValueOnce(["do-a", "do-b"])
      doMock.stubFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ sent: "invalid" }), { status: 200 }))
        .mockRejectedValueOnce(new Error("network"))
      const deliveryFailure = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-update",
        { method: "POST" },
      ), env as any)
      expect(deliveryFailure.status).toBe(503)
      expect(await deliveryFailure.json()).toEqual({ error: "failed to forward machine update" })
    })
  })

  describe("POST /community-machine/by-id/:machineId/forward-agent-reset", () => {
    const validBody = {
      agentId: "bot-1",
      config: { version: 1, runtime: "claude", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l-1",
    }

    beforeEach(() => {
      mockGetActiveDoNamesForMachine.mockReset()
      mockGetActiveDoNamesForMachine.mockResolvedValue([])
    })

    it("rejects missing agentId with 400 without touching D1 or the DOs", async () => {
      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-reset", {
        method: "POST",
        body: JSON.stringify({ config: validBody.config, launchId: "l-1" }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
      expect(mockGetActiveDoNamesForMachine).not.toHaveBeenCalled()
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("rejects extra unexpected fields with 400", async () => {
      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-reset", {
        method: "POST",
        body: JSON.stringify({ ...validBody, sneaky: "value" }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("zero active doNames → { sent: 0 } without touching any DO", async () => {
      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-reset", {
        method: "POST",
        body: JSON.stringify(validBody),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("well-formed body → forwards a { type:'agent:reset', ... } frame to each DO's /push and aggregates sent", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-abc"])
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-reset", {
        method: "POST",
        body: JSON.stringify(validBody),
      })
      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:do-abc")
      const stubReq = doMock.stubFetch.mock.calls[0][0] as Request
      expect(stubReq.url).toBe("http://internal/push")
      const forwardedBody = await stubReq.text()
      const parsed = JSON.parse(forwardedBody)
      expect(parsed).toEqual({ type: "agent:reset", agentId: "bot-1", config: validBody.config, launchId: "l-1" })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 1 })
    })
  })

  describe("POST /community-machine/by-id/:machineId/forward-batch-reset", () => {
    const resets = [
      {
        agentId: "bot-1",
        config: { version: 1, runtime: "claude", model: { kind: "default" }, mode: { kind: "default" } },
        launchId: "launch-1",
      },
      {
        agentId: "bot-2",
        config: { version: 2, runtime: "codex", model: { kind: "named", name: "gpt-5" }, mode: { kind: "default" } },
        launchId: "launch-2",
      },
    ]

    beforeEach(() => {
      mockGetActiveDoNamesForMachine.mockReset()
      mockGetActiveDoNamesForMachine.mockResolvedValue([])
    })

    it("rejects both an invalid top-level shape and an invalid reset item", async () => {
      const invalidTop = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-batch-reset",
        { method: "POST", body: JSON.stringify({ resets, extra: true }) },
      ), env as any)
      const invalidItem = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-batch-reset",
        { method: "POST", body: JSON.stringify({ resets: [{ ...resets[0], extra: true }] }) },
      ), env as any)

      expect(invalidTop.status).toBe(400)
      expect(await invalidTop.json()).toEqual({ error: "invalid payload" })
      expect(invalidItem.status).toBe(400)
      expect(await invalidItem.json()).toEqual({ error: "invalid payload" })
      expect(mockGetActiveDoNamesForMachine).not.toHaveBeenCalled()
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("returns { sent: 0 } without touching a DO when no active names exist", async () => {
      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-batch-reset",
        { method: "POST", body: JSON.stringify({ resets }) },
      ), env as any)

      expect(mockGetActiveDoNamesForMachine).toHaveBeenCalledWith({}, "machine-1")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("forwards the exact machine:reset_all frame and aggregates every delivered count", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"])
      doMock.stubFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ sent: 2 }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-batch-reset",
        { method: "POST", body: JSON.stringify({ resets }) },
      ), env as any)

      expect(doMock.idFromName.mock.calls.map(([name]) => name)).toEqual([
        "community-machine:do-a",
        "community-machine:do-b",
      ])
      expect(doMock.stubFetch).toHaveBeenCalledTimes(2)
      const internal = doMock.stubFetch.mock.calls[0][0] as Request
      expect(internal.url).toBe("http://internal/push")
      expect(internal.method).toBe("POST")
      expect(internal.headers.get("content-type")).toBe("application/json")
      expect(await internal.json()).toEqual({ type: "machine:reset_all", resets })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 3 })
    })

    it("returns the exact retryable 503 when every active DO fails transiently", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"])
      doMock.stubFetch
        .mockResolvedValueOnce(new Response("down", { status: 502 }))
        .mockRejectedValueOnce(new Error("network"))
      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-batch-reset",
        { method: "POST", body: JSON.stringify({ resets }) },
      ), env as any)

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "failed to forward batch reset" })
      expect(doMock.stubFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe("POST /community-machine/by-id/:machineId/forward-agent-nap", () => {
    const validBody = {
      agentId: "bot-1",
      config: { version: 1, runtime: "codex", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "launch-1",
      handoff: "Resume the queued review.",
    }

    beforeEach(() => {
      mockGetActiveDoNamesForMachine.mockReset()
      mockGetActiveDoNamesForMachine.mockResolvedValue([])
    })

    it("rejects a blank handoff with the exact invalid-payload response", async () => {
      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-nap",
        { method: "POST", body: JSON.stringify({ ...validBody, handoff: "   " }) },
      ), env as any)

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "invalid payload" })
      expect(mockGetActiveDoNamesForMachine).not.toHaveBeenCalled()
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("returns { sent: 0 } without touching a DO when no active names exist", async () => {
      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-nap",
        { method: "POST", body: JSON.stringify(validBody) },
      ), env as any)

      expect(mockGetActiveDoNamesForMachine).toHaveBeenCalledWith({}, "machine-1")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("forwards the exact agent:nap frame and aggregates every delivered count", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"])
      doMock.stubFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sent: 2 }), { status: 200 }))
      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-nap",
        { method: "POST", body: JSON.stringify(validBody) },
      ), env as any)

      expect(doMock.stubFetch).toHaveBeenCalledTimes(2)
      const internal = doMock.stubFetch.mock.calls[0][0] as Request
      expect(internal.url).toBe("http://internal/push")
      expect(internal.method).toBe("POST")
      expect(internal.headers.get("content-type")).toBe("application/json")
      expect(await internal.json()).toEqual({ type: "agent:nap", ...validBody })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 3 })
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
