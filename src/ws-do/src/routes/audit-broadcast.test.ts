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

  describe("POST /internal/broadcast-bot-audit-event", () => {
    it("forwards a well-formed audit event to the owner's user-DO with the community:bot.audit_event shape", async () => {
      doMock.stubFetch.mockResolvedValue(new Response("ok"))
      const payload = {
        botId: "bot_1",
        ownerUserId: "owner_1",
        id: "evt_1",
        kind: "wake_trigger",
        payload: {
          messageId: "msg_1",
          channel: "/srv_1/general",
          seq: 7,
          senderId: "u_human",
          senderHandle: "@gustavo#0042",
          reason: "unread",
        },
        createdAt: "2026-07-23T00:00:00.000Z",
      }
      const req = new Request("http://localhost/internal/broadcast-bot-audit-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      const res = await handler.fetch(req, env as any)

      expect(res.status).toBe(204)
      expect(doMock.idFromName).toHaveBeenCalledWith("user:owner_1")
      const stubReq = doMock.stubFetch.mock.calls[0][0] as Request
      expect(stubReq.url).toBe("http://internal/broadcast")
      const body = JSON.parse(await stubReq.text()) as Record<string, unknown>
      // Matches the shape ws-durable.ts emits for daemon-originating frames.
      expect(body.type).toBe("community:bot.audit_event")
      expect(body.botId).toBe("bot_1")
      expect(body.id).toBe("evt_1")
      expect(body.kind).toBe("wake_trigger")
      expect(body.createdAt).toBe(payload.createdAt)
      expect(body.payload).toEqual(payload.payload)
    })

    it("400s on invalid JSON", async () => {
      const req = new Request("http://localhost/internal/broadcast-bot-audit-event", {
        method: "POST",
        body: "not json",
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("400s on a payload missing required fields", async () => {
      const req = new Request("http://localhost/internal/broadcast-bot-audit-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botId: "bot_1" }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("400s on an unknown kind (rejects browser-untypeable rows at the boundary)", async () => {
      const req = new Request("http://localhost/internal/broadcast-bot-audit-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botId: "bot_1",
          ownerUserId: "owner_1",
          id: "evt_1",
          kind: "some_future_kind",
          payload: {},
          createdAt: "2026-07-23T00:00:00.000Z",
        }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(400)
    })

    it("503s and never broadcasts when the DO fetch throws", async () => {
      doMock.stubFetch.mockRejectedValue(new Error("do down"))
      const req = new Request("http://localhost/internal/broadcast-bot-audit-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botId: "bot_1",
          ownerUserId: "owner_1",
          id: "evt_1",
          kind: "wake_trigger",
          payload: {},
          createdAt: "2026-07-23T00:00:00.000Z",
        }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(503)
    })

    it("accepts kind: 'model_changed' (guards the AUDIT_KINDS allowlist)", async () => {
      doMock.stubFetch.mockResolvedValue(new Response("ok"))
      const req = new Request("http://localhost/internal/broadcast-bot-audit-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botId: "bot_1",
          ownerUserId: "owner_1",
          id: "evt_m",
          kind: "model_changed",
          payload: { from: "claude-opus-4-6", to: "claude-sonnet-4-6" },
          createdAt: "2026-07-26T00:00:00.000Z",
        }),
      })
      const res = await handler.fetch(req, env as any)
      expect(res.status).toBe(204)
      const body = JSON.parse(await (doMock.stubFetch.mock.calls[0][0] as Request).text()) as Record<string, unknown>
      expect(body.kind).toBe("model_changed")
      expect(body.payload).toEqual({ from: "claude-opus-4-6", to: "claude-sonnet-4-6" })
    })
  })
})
