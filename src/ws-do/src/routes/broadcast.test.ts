import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createRouterTestContext,
  loadRouter,
  getSharedMocks,
  type RouterHandler,
  type RouterTestContext,
} from "./test-harness"
import { INTERNAL_USER_TARGET_HEADER } from "../internal-user-broadcast"

const sharedMocks = getSharedMocks()
const mockHashCredential = sharedMocks.hashCredential
const mockDoNameFromHash = sharedMocks.doNameFromHash
const mockGetActiveDoNamesForMachine = sharedMocks.getActiveDoNamesForMachine
const loggerMocks = {
  child: sharedMocks.loggerChild,
  debug: sharedMocks.loggerDebug,
  info: sharedMocks.loggerInfo,
  warn: sharedMocks.loggerWarn,
}

function makeBulkRequest(body: string): Request {
  return new Request("http://localhost/broadcast/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Trace-Id": "trace-bulk" },
    body,
  })
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

    it("forwards POST /broadcast/user/:userId with a router-owned target marker", async () => {
      doMock.stubFetch.mockResolvedValue(new Response("ok"))
      const body = JSON.stringify({ type: "runtime.status", daemonId: "d1", workspaceId: "w1", status: "online" })
      const req = new Request("http://localhost/broadcast/user/user-123", {
        method: "POST",
        headers: { [INTERNAL_USER_TARGET_HEADER]: "attacker-spoof" },
        body,
      })

      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("user:user-123")
      expect(doMock.get).toHaveBeenCalledWith("mock-do-id")
      expect(doMock.stubFetch).toHaveBeenCalled()
      const stubReq = doMock.stubFetch.mock.calls[0][0] as Request
      expect(stubReq.url).toBe("http://internal/broadcast")
      expect(stubReq.method).toBe("POST")
      expect(stubReq.headers.get(INTERNAL_USER_TARGET_HEADER)).toBe("user-123")
      expect(await stubReq.text()).toBe(body)
      expect(res.status).toBe(200)
    })

    it.each([
      ["malformed JSON", "{"],
      ["null body", "null"],
      ["array body", "[]"],
      ["missing userIds", JSON.stringify({ message: { type: "event" } })],
      ["non-array userIds", JSON.stringify({ userIds: "u1", message: { type: "event" } })],
      ["empty user id", JSON.stringify({ userIds: [""], message: { type: "event" } })],
      ["non-string user id", JSON.stringify({ userIds: [1], message: { type: "event" } })],
      ["missing message", JSON.stringify({ userIds: [] })],
      ["null message", JSON.stringify({ userIds: [], message: null })],
      ["array message", JSON.stringify({ userIds: [], message: [] })],
      ["missing message type", JSON.stringify({ userIds: [], message: {} })],
      ["empty message type", JSON.stringify({ userIds: [], message: { type: "" } })],
      ["non-string message type", JSON.stringify({ userIds: [], message: { type: 1 } })],
      ["null exclusion", JSON.stringify({ userIds: [], message: { type: "event" }, excludeUserId: null })],
      ["empty exclusion", JSON.stringify({ userIds: [], message: { type: "event" }, excludeUserId: "" })],
      ["non-string exclusion", JSON.stringify({ userIds: [], message: { type: "event" }, excludeUserId: 1 })],
    ])("rejects %s before Durable Object access", async (_label, body) => {
      const res = await handler.fetch(makeBulkRequest(body), env as any)

      expect(res.status).toBe(400)
      expect(doMock.idFromName).not.toHaveBeenCalled()
      expect(doMock.get).not.toHaveBeenCalled()
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("rejects 1,001 raw duplicate ids before dedupe or Durable Object access", async () => {
      const res = await handler.fetch(makeBulkRequest(JSON.stringify({
        userIds: Array.from({ length: 1001 }, () => "duplicate"),
        message: { type: "event" },
      })), env as any)

      expect(res.status).toBe(400)
      expect(doMock.idFromName).not.toHaveBeenCalled()
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("accepts exactly 1,000 raw ids", async () => {
      doMock.stubFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ sent: 1 }), { status: 200 }),
      )
      const res = await handler.fetch(makeBulkRequest(JSON.stringify({
        userIds: Array.from({ length: 1000 }, (_, index) => `u${index}`),
        message: { type: "event" },
      })), env as any)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ sent: 1000 })
      expect(doMock.stubFetch).toHaveBeenCalledTimes(1000)
    })

    it("returns sent zero for an empty target list without namespace access", async () => {
      const res = await handler.fetch(makeBulkRequest(JSON.stringify({
        userIds: [],
        message: { type: "event" },
      })), env as any)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ sent: 0 })
      expect(doMock.idFromName).not.toHaveBeenCalled()
      expect(doMock.stubFetch).not.toHaveBeenCalled()
      expect(loggerMocks.info).toHaveBeenCalledWith(
        "bulk user broadcast complete",
        expect.objectContaining({
          targetCount: 0,
          resultCount: 0,
          successCount: 0,
          failureCount: 0,
          failureCounts: {
            throw: 0,
            "non-ok": 0,
            "invalid-json": 0,
            "invalid-sent": 0,
          },
          sent: 0,
          maxActive: 0,
          batchSize: 40,
          batchCount: 0,
          durationMs: expect.any(Number),
        }),
      )
    })

    it("returns sent zero when exclusion removes the only unique target", async () => {
      const res = await handler.fetch(makeBulkRequest(JSON.stringify({
        userIds: ["u1", "u1"],
        message: { type: "event" },
        excludeUserId: "u1",
      })), env as any)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ sent: 0 })
      expect(doMock.idFromName).not.toHaveBeenCalled()
      expect(doMock.stubFetch).not.toHaveBeenCalled()
    })

    it("dedupes in first-seen order, excludes afterward, serializes once, and creates fresh requests", async () => {
      doMock.stubFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ sent: 1 }), { status: 200 }),
      )
      const request = makeBulkRequest(JSON.stringify({
        userIds: ["u2", "u1", "u2", "u3", "u1"],
        message: { type: "event", value: 7 },
        excludeUserId: "u1",
      }))
      const stringify = vi.spyOn(JSON, "stringify")

      const res = await handler.fetch(request, env as any)
      const messageStringifyCount = stringify.mock.calls.filter(([value]) => (
        typeof value === "object" && value !== null && !Array.isArray(value)
        && (value as Record<string, unknown>).type === "event"
      )).length

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ sent: 2 })
      expect(doMock.idFromName.mock.calls.map(([name]) => name)).toEqual(["user:u2", "user:u3"])
      expect(doMock.get).toHaveBeenCalledTimes(2)
      expect(doMock.stubFetch).toHaveBeenCalledTimes(2)
      const internalRequests = doMock.stubFetch.mock.calls.map(([internal]) => internal as Request)
      expect(new Set(internalRequests).size).toBe(2)
      expect(internalRequests.map((internal) => internal.url)).toEqual([
        "http://internal/broadcast",
        "http://internal/broadcast",
      ])
      expect(internalRequests.map((internal) => internal.method)).toEqual(["POST", "POST"])
      expect(internalRequests.map((internal) => (
        internal.headers.get(INTERNAL_USER_TARGET_HEADER)
      ))).toEqual(["u2", "u3"])
      await expect(Promise.all(internalRequests.map((internal) => internal.text()))).resolves.toEqual([
        JSON.stringify({ type: "event", value: 7 }),
        JSON.stringify({ type: "event", value: 7 }),
      ])
      expect(messageStringifyCount).toBe(1)
      expect(loggerMocks.child).toHaveBeenCalledWith({
        traceId: "trace-bulk",
        rawCount: 5,
        uniqueCount: 3,
        targetCount: 2,
        excludedCount: 1,
      })
    })

    it.each([1, 40, 41, 81])(
      "limits %i targets to sequential batches of at most forty",
      async (targetCount) => {
        let active = 0
        let completed = 0
        let maximum = 0
        const startedAfterCompleted: number[] = []
        doMock.stubFetch.mockImplementation(async () => {
          startedAfterCompleted.push(completed)
          active += 1
          maximum = Math.max(maximum, active)
          await Promise.resolve()
          active -= 1
          completed += 1
          return new Response(JSON.stringify({ sent: 1 }), { status: 200 })
        })
        const userIds = Array.from({ length: targetCount }, (_, index) => `u${index}`)

        const res = await handler.fetch(makeBulkRequest(JSON.stringify({
          userIds,
          message: { type: "event" },
        })), env as any)

        await expect(res.json()).resolves.toEqual({ sent: targetCount })
        expect(maximum).toBe(Math.min(targetCount, 40))
        if (targetCount > 40) expect(startedAfterCompleted[40]).toBe(40)
        if (targetCount > 80) expect(startedAfterCompleted[80]).toBe(80)
        expect(loggerMocks.info).toHaveBeenCalledWith(
          "bulk user broadcast complete",
          expect.objectContaining({
            targetCount,
            resultCount: targetCount,
            successCount: targetCount,
            failureCount: 0,
            sent: targetCount,
            maxActive: Math.min(targetCount, 40),
            batchSize: 40,
            batchCount: Math.ceil(targetCount / 40),
            durationMs: expect.any(Number),
          }),
        )
      },
    )

    it("continues after every failure shape and aggregates authenticated-tab sent counts", async () => {
      doMock.stubFetch.mockImplementation(async () => {
        const index = doMock.stubFetch.mock.calls.length - 1
        if (index === 0) throw new Error("stub down")
        if (index === 1) return new Response("no", { status: 503 })
        if (index === 2) return new Response("not-json", { status: 200 })
        if (index === 3) return new Response(JSON.stringify({ sent: -1 }), { status: 200 })
        if (index === 4) return new Response(JSON.stringify({ sent: 2 }), { status: 200 })
        return new Response(JSON.stringify({ sent: 3 }), { status: 200 })
      })

      const res = await handler.fetch(makeBulkRequest(JSON.stringify({
        userIds: ["throws", "non-ok", "bad-json", "bad-sent", "good-two", "good-three"],
        message: { type: "event" },
      })), env as any)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ sent: 5 })
      expect(doMock.stubFetch).toHaveBeenCalledTimes(6)
      expect(loggerMocks.warn.mock.calls.map(([, fields]) => (
        fields as { failureKind?: string }
      ).failureKind)).toEqual(["throw", "non-ok", "invalid-json", "invalid-sent"])
      expect(loggerMocks.warn).toHaveBeenNthCalledWith(
        2,
        "bulk user broadcast target failed",
        expect.objectContaining({ userId: "non-ok", failureKind: "non-ok", status: 503 }),
      )
      expect(loggerMocks.info).toHaveBeenCalledWith(
        "bulk user broadcast complete",
        expect.objectContaining({
          targetCount: 6,
          resultCount: 6,
          successCount: 2,
          failureCount: 4,
          failureCounts: {
            throw: 1,
            "non-ok": 1,
            "invalid-json": 1,
            "invalid-sent": 1,
          },
          sent: 5,
          maxActive: 6,
          batchSize: 40,
          batchCount: 1,
          durationMs: expect.any(Number),
        }),
      )
    })
  })
})
