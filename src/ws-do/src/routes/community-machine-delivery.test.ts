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
const mockWithD1Retry = sharedMocks.withD1Retry
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

  describe("POST /community-machine/by-id/:machineId/push", () => {
    beforeEach(() => {
      mockGetActiveDoNamesForMachine.mockReset()
      mockGetActiveDoNamesForMachine.mockResolvedValue([])
    })

    it("treats a D1 lookup failure as best-effort { sent: 0 }", async () => {
      mockGetActiveDoNamesForMachine.mockRejectedValue(new Error("d1 unavailable"))
      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/push",
        { method: "POST", body: JSON.stringify({ type: "bot:updated" }) },
      ), env as any)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("returns { sent: 0 } without touching a DO when no active names exist", async () => {
      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/push",
        { method: "POST", body: JSON.stringify({ type: "bot:removed" }) },
      ), env as any)

      expect(mockGetActiveDoNamesForMachine).toHaveBeenCalledWith({}, "machine-1")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("decodes the machine id and best-effort fans the verbatim body to every active DO", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b", "do-c"])
      doMock.stubFetch
        .mockResolvedValueOnce(new Response("ok", { status: 200 }))
        .mockResolvedValueOnce(new Response("offline", { status: 503 }))
        .mockRejectedValueOnce(new Error("gone"))
      const body = JSON.stringify({ type: "bot:added", botId: "bot-1" })
      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine%20one/push",
        { method: "POST", body },
      ), env as any)

      expect(mockGetActiveDoNamesForMachine).toHaveBeenCalledWith({}, "machine one")
      expect(doMock.idFromName.mock.calls.map(([name]) => name)).toEqual([
        "community-machine:do-a",
        "community-machine:do-b",
        "community-machine:do-c",
      ])
      expect(doMock.stubFetch).toHaveBeenCalledTimes(3)
      const internal = doMock.stubFetch.mock.calls[0][0] as Request
      expect(internal.url).toBe("http://internal/push")
      expect(internal.method).toBe("POST")
      expect(internal.headers.get("content-type")).toBe("application/json")
      expect(await internal.text()).toBe(body)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 1 })
    })
  })

  describe("POST /community-machine/by-id/:machineId/forward-agent-wake", () => {
    beforeEach(() => {
      mockGetActiveDoNamesForMachine.mockReset()
      mockGetActiveDoNamesForMachine.mockResolvedValue([])
      mockWithD1Retry.mockReset()
      mockWithD1Retry.mockImplementation(async (fn) => fn())
    })

    it("zero active doNames → dual-write zero without touching any DO", async () => {
      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(mockGetActiveDoNamesForMachine).toHaveBeenCalledWith({}, "machine-1")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ attempted: 0, sent: 0 })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("single active doName, daemon connected → forwards and aggregates attempted count", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-abc"])
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ attempted: 1, sent: 1 }), { status: 200 }))

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
      expect(await res.json()).toEqual({ attempted: 1, sent: 1 })
    })

    it("daemon offline (DO reports { attempted: 0 }) → does not count a write", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-abc"])
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ attempted: 0 }), { status: 200 }))

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ attempted: 0, sent: 0 })
    })

    it("multi-doName fan-out: both DOs hit, aggregate sums attempted counts", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"])
      let call = 0
      doMock.stubFetch.mockImplementation(() => {
        call++
        const attempted = call === 1 ? 0 : 1
        return Promise.resolve(new Response(JSON.stringify({ attempted }), { status: 200 }))
      })

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:do-a")
      expect(doMock.idFromName).toHaveBeenCalledWith("community-machine:do-b")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ attempted: 1, sent: 1 })
    })

    it("DO fetch throws — other doNames are evaluated but the aggregate remains retryable", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"])
      let call = 0
      doMock.stubFetch.mockImplementation(() => {
        call++
        if (call === 1) return Promise.reject(new Error("network error"))
        return Promise.resolve(new Response(JSON.stringify({ attempted: 1 }), { status: 200 }))
      })

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(doMock.stubFetch).toHaveBeenCalledTimes(2)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "failed to forward agent wake" })
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

    it("non-2xx or malformed DO responses → retryable 503", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-a", "do-b"])
      let call = 0
      doMock.stubFetch.mockImplementation(() => {
        call++
        if (call === 1) return Promise.resolve(new Response("oops", { status: 502 }))
        return Promise.resolve(new Response(JSON.stringify({ attempted: "bad" }), { status: 200 }))
      })

      const req = new Request("http://localhost/community-machine/by-id/machine-1/forward-agent-wake", {
        method: "POST",
        body: JSON.stringify({ type: "agent:wake" }),
      })
      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "failed to forward agent wake" })
    })

    it("accepts a legacy sent-only inner DO and dual-writes the outer receipt", async () => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-legacy"])
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))

      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-wake",
        { method: "POST", body: JSON.stringify({ type: "agent:wake" }) },
      ), env as any)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ attempted: 1, sent: 1 })
    })

    it.each([
      ["missing", {}],
      ["negative", { attempted: -1 }],
      ["fractional", { attempted: 0.5 }],
      ["mismatched", { attempted: 1, sent: 0 }],
    ])("maps a %s inner receipt to retryable 503", async (_name, receipt) => {
      mockGetActiveDoNamesForMachine.mockResolvedValue(["do-bad"])
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify(receipt), { status: 200 }))

      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-wake",
        { method: "POST", body: JSON.stringify({ type: "agent:wake" }) },
      ), env as any)

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "failed to forward agent wake" })
    })

    it("DB lookup failure → retryable 503, not { attempted: 0 }", async () => {
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

    it("retries a transient SQLITE_BUSY lookup before forwarding the wake", async () => {
      mockGetActiveDoNamesForMachine
        .mockRejectedValueOnce(new Error("SQLITE_BUSY_SNAPSHOT: database is locked"))
        .mockResolvedValueOnce(["do-abc"])
      mockWithD1Retry.mockImplementation(async (fn) => {
        try {
          return await fn()
        } catch {
          return fn()
        }
      })
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ attempted: 1 }), { status: 200 }))

      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-wake",
        { method: "POST", body: JSON.stringify({ type: "agent:wake" }) },
      ), env as any)

      expect(mockGetActiveDoNamesForMachine).toHaveBeenCalledTimes(2)
      expect(mockWithD1Retry).toHaveBeenCalledWith(expect.any(Function), {
        route: "ws-do:agent-wake-machine-resolution",
      })
      expect(doMock.stubFetch).toHaveBeenCalledTimes(1)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ attempted: 1, sent: 1 })
    })

    it("maps exhausted SQLITE_BUSY retries to the existing 503 response", async () => {
      mockGetActiveDoNamesForMachine.mockRejectedValue(
        new Error("SQLITE_BUSY_SNAPSHOT: database is locked"),
      )
      mockWithD1Retry.mockImplementation(async (fn) => {
        let lastError: unknown
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            return await fn()
          } catch (error) {
            lastError = error
          }
        }
        throw lastError
      })

      const res = await handler.fetch(new Request(
        "http://localhost/community-machine/by-id/machine-1/forward-agent-wake",
        { method: "POST", body: JSON.stringify({ type: "agent:wake" }) },
      ), env as any)

      expect(mockGetActiveDoNamesForMachine).toHaveBeenCalledTimes(4)
      expect(mockWithD1Retry).toHaveBeenCalledWith(expect.any(Function), {
        route: "ws-do:agent-wake-machine-resolution",
      })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "failed to resolve machine" })
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })
  })
})
