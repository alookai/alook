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
  info: sharedMocks.loggerInfo,
  warn: sharedMocks.loggerWarn,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
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

  describe("POST /presence/users", () => {
    it("empty ids array short-circuits and performs zero DO fetches", async () => {
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [] }),
      })

      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ online: [] })
      expect(doMock.idFromName).not.toHaveBeenCalled()
      expect(doMock.get).not.toHaveBeenCalled()
      expect(doMock.stubFetch).not.toHaveBeenCalled()
      expect(loggerMocks.info).toHaveBeenCalledWith(
        "bulk_presence_check_complete",
        expect.objectContaining({
          targetCount: 0,
          resultCount: 0,
          successCount: 0,
          onlineCount: 0,
          offlineCount: 0,
          staleCount: 0,
          failureCount: 0,
          failureCounts: {
            throw: 0,
            "non-ok": 0,
            "invalid-json": 0,
            "invalid-body": 0,
          },
          maxActive: 0,
          batchSize: 40,
          batchCount: 0,
          durationMs: expect.any(Number),
        }),
      )
    })

    it("returns only online ids from mixed responses", async () => {
      doMock.stubFetch.mockImplementation((req: Request) => {
        // Round-robin: we can't tell which id -- rely on call order.
        const idx = doMock.stubFetch.mock.calls.length - 1
        const online = idx % 2 === 0 // u1 online, u2 offline, u3 online
        return Promise.resolve(new Response(JSON.stringify({ online }), { status: 200 }))
      })

      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["u1", "u2", "u3"] }),
      })

      const res = await handler.fetch(req, env as any)
      const body = await res.json() as { online: string[] }

      expect(res.status).toBe(200)
      expect(body.online).toEqual(["u1", "u3"])
    })

    it("returns empty online list when all ids are offline", async () => {
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ online: false }), { status: 200 }))

      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["a", "b", "c"] }),
      })

      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ online: [] })
    })

    it("passes ?userId=<id> on every /check-user-online request — the target DO can't recover its own name from ctx (Fix 3)", async () => {
      doMock.stubFetch.mockResolvedValue(new Response(JSON.stringify({ online: true }), { status: 200 }))

      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["bot-1", "human-2"] }),
      })

      await handler.fetch(req, env as any)

      const urls = doMock.stubFetch.mock.calls.map(([r]) => (r as Request).url)
      expect(urls).toContain("http://internal/check-user-online?userId=bot-1")
      expect(urls).toContain("http://internal/check-user-online?userId=human-2")
    })

    it("returns 400 on malformed body — missing ids", async () => {
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("returns 400 on malformed body — ids is not an array", async () => {
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: "u1" }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("returns 400 on malformed body — non-string entries", async () => {
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["u1", 42, "u3"] }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("returns 400 on invalid JSON body", async () => {
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("returns 400 when ids array exceeds cap", async () => {
      const ids = Array.from({ length: 1001 }, (_, i) => `u${i}`)
      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it.each([1, 40, 41, 81, 1000])(
      "limits %i presence targets to sequential batches of at most forty",
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
          return new Response(JSON.stringify({ online: false }), { status: 200 })
        })
        const ids = Array.from({ length: targetCount }, (_, index) => `u${index}`)

        const res = await handler.fetch(new Request("http://localhost/presence/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        }), env as any)

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ online: [] })
        expect(maximum).toBe(Math.min(targetCount, 40))
        if (targetCount > 40) expect(startedAfterCompleted[40]).toBe(40)
        if (targetCount > 80) expect(startedAfterCompleted[80]).toBe(80)
        expect(loggerMocks.info).toHaveBeenCalledWith(
          "bulk_presence_check_complete",
          expect.objectContaining({
            targetCount,
            resultCount: targetCount,
            successCount: targetCount,
            onlineCount: 0,
            offlineCount: targetCount,
            staleCount: 0,
            failureCount: 0,
            maxActive: Math.min(targetCount, 40),
            batchSize: 40,
            batchCount: Math.ceil(targetCount / 40),
            durationMs: expect.any(Number),
          }),
        )
      },
    )

    it("keeps online ids in input order when target responses settle out of order", async () => {
      const gates = new Map([
        ["u1", deferred<Response>()],
        ["u2", deferred<Response>()],
        ["u3", deferred<Response>()],
      ])
      doMock.stubFetch.mockImplementation((request: Request) => {
        const userId = new URL(request.url).searchParams.get("userId")
        return gates.get(userId ?? "")?.promise ?? Promise.reject(new Error("missing gate"))
      })

      const req = new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["u1", "u2", "u3"] }),
      })
      const responsePromise = handler.fetch(req, env as any)

      await vi.waitFor(() => expect(doMock.stubFetch).toHaveBeenCalledTimes(3))
      gates.get("u3")?.resolve(Response.json({ online: true }))
      gates.get("u2")?.resolve(Response.json({ online: false }))
      gates.get("u1")?.resolve(Response.json({ online: true }))

      const res = await responsePromise

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ online: ["u1", "u3"] })
    })

    it("classifies partial failures and continues evaluating every target", async () => {
      doMock.stubFetch.mockImplementation(async () => {
        const index = doMock.stubFetch.mock.calls.length - 1
        if (index === 0) throw new Error("stub down")
        if (index === 1) return new Response("unavailable", { status: 503 })
        if (index === 2) return new Response("not-json", { status: 200 })
        if (index === 3) return Response.json({ online: "yes" })
        if (index === 4) return Response.json({ online: false, stale: true })
        if (index === 5) return Response.json({ online: false })
        return Response.json({ online: true })
      })

      const ids = [
        "throws",
        "non-ok",
        "bad-json",
        "bad-body",
        "stale",
        "offline",
        "online-1",
        "online-2",
      ]
      const res = await handler.fetch(new Request("http://localhost/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }), env as any)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ online: ["online-1", "online-2"] })
      expect(doMock.stubFetch).toHaveBeenCalledTimes(ids.length)
      expect(loggerMocks.warn.mock.calls.map(([, fields]) => (
        fields as { failureKind?: string }
      ).failureKind)).toEqual(["throw", "non-ok", "invalid-json", "invalid-body"])
      expect(loggerMocks.info).toHaveBeenCalledWith(
        "bulk_presence_check_complete",
        expect.objectContaining({
          targetCount: 8,
          resultCount: 8,
          successCount: 3,
          onlineCount: 2,
          offlineCount: 1,
          staleCount: 1,
          failureCount: 4,
          failureCounts: {
            throw: 1,
            "non-ok": 1,
            "invalid-json": 1,
            "invalid-body": 1,
          },
          maxActive: 8,
          batchSize: 40,
          batchCount: 1,
          durationMs: expect.any(Number),
        }),
      )
      const completionFields = loggerMocks.info.mock.calls.find(
        ([message]) => message === "bulk_presence_check_complete",
      )?.[1] as Record<string, unknown>
      expect(Object.keys(completionFields).sort()).toEqual([
        "batchCount",
        "batchSize",
        "durationMs",
        "failureCount",
        "failureCounts",
        "maxActive",
        "offlineCount",
        "onlineCount",
        "resultCount",
        "staleCount",
        "successCount",
        "targetCount",
      ])
    })
  })

  describe("compat: GET /presence/user/:uid", () => {
    it("still returns { online: boolean } (kept for rollout safety)", async () => {
      doMock.stubFetch.mockResolvedValue(
        new Response(JSON.stringify({ online: true }), { status: 200 })
      )
      const req = new Request("http://localhost/presence/user/user-789", { method: "GET" })
      const res = await handler.fetch(req, env as any)

      expect(doMock.idFromName).toHaveBeenCalledWith("user:user-789")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ online: true })
      const stubReq = doMock.stubFetch.mock.calls[0][0] as Request
      expect(stubReq.url).toBe("http://internal/check-user-online?userId=user-789")
    })
  })
})
