import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  deriveCommunityDeliveryOperationId,
  prepareCommunityDeliveryEvents,
} from "@alook/shared"
import { createMockWebSocket } from "../__mocks__/cf"
import { handleUpgrade } from "../routes/upgrade"
import { INTERNAL_USER_TARGET_HEADER } from "../internal-user-broadcast"
import type { CommunityDeliveryReceipt } from "../community-delivery-receipt"
import { COMMUNITY_CONNECTION_STATE_JSON_MAX_BYTES } from "./internal"
import {
  CFResponse,
  cleanupHarness,
  createDO,
  flushAsyncWork,
  mockCheckAliveFetch,
  mockCreateDb,
  mockEncodePreparedCommunityBrowserEventBatch,
  mockFindCredentialByHash,
  mockGetBotBinding,
  mockGetBotBindingWithOwner,
  mockGetChannelForMember,
  mockGetChannelType,
  mockGetCoMemberUserIds,
  mockGetDM,
  mockGetFriendUserIds,
  mockGetLatestTokenForUser,
  mockGetMachineByDaemon,
  mockGetMachineByIdForUser,
  mockGetMachineTokenByToken,
  mockGetPrivateChannelAudienceUserIds,
  mockGetProfile,
  mockGetRuntimeIdsByDaemon,
  mockGetUserInternal,
  mockGetValidSession,
  mockGetValidSessionWithIdentity,
  mockHashCredential,
  mockInsertBotActivityEventAndPrune,
  mockInsertBotAuditModelChanged,
  mockInsertBotAuditNap,
  mockInsertBotAuditProviderChanged,
  mockInsertBotAuditSessionReset,
  mockIsBotOnline,
  mockIsChannelPrivate,
  mockListBotsForMachine,
  mockListChannelMemberUserIds,
  mockListMembers,
  mockListThreadParticipantUserIds,
  mockMarkMachineOffline,
  mockMarkMachineOnlineIfOffline,
  mockLogWarn,
  mockReconcileBotActivityFromRunningAgents,
  mockResolveScopeMemberUserIds,
  mockStubFetch,
  mockToSummary,
  mockTouchBotRefreshContext,
  mockTouchMachineHeartbeat,
  mockUpdateProfile,
  mockUpsertMachineByMachineId,
  mockWithD1Retry,
  resetHarness
} from "./test-harness"

describe("WebSocketDurableObject", () => {
  beforeEach(() => resetHarness())
  afterEach(() => cleanupHarness())

  describe("fetch — strict community broadcast", () => {
    const event = {
      type: "community:status.update",
      userId: "user-42",
      statusEmoji: null,
      statusText: "ready",
    }

    it("delivers a validated self-event to the authenticated target socket", async () => {
      const { durable, ctx } = createDO()
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])

      const res = await durable.fetch(new Request("http://internal/community-broadcast", {
        method: "POST",
        headers: { [INTERNAL_USER_TARGET_HEADER]: encodeURIComponent("user-42") },
        body: JSON.stringify(event),
      }))

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ sent: 1 })
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify(event))
    })

    it("rejects removed-version, invalid, and oversized frames before socket delivery", async () => {
      const { durable, ctx } = createDO()
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])
      const request = (body: string) => new Request("http://internal/community-broadcast", {
        method: "POST",
        headers: { [INTERNAL_USER_TARGET_HEADER]: "user-42" },
        body,
      })

      expect((await durable.fetch(request(JSON.stringify({
        ...event,
        contractVersion: 1,
      })))).status).toBe(400)
      expect((await durable.fetch(request(JSON.stringify({
        ...event,
        extra: true,
      })))).status).toBe(400)
      expect((await durable.fetch(request("x".repeat(65_537)))).status).toBe(400)
      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe("fetch — strict community ordered bundle", () => {
    const events = [
      {
        type: "community:message.create",
        channelId: "ch-1",
        message: {
          id: "m-1",
          seq: 1,
          authorId: "author",
          authorName: "Alice",
          content: "hello",
          type: "chat",
          createdAt: "2026-08-18T00:00:00.000Z",
        },
      },
      {
        type: "community:unread.bump",
        userId: "user-42",
        channelId: "ch-1",
        isMention: false,
      },
      {
        type: "community:mention.create",
        userId: "user-42",
        messageId: "m-1",
        channelId: "ch-1",
        authorName: "Alice",
      },
    ]

    async function requestFor(
      inputEvents: readonly unknown[] = events,
      overrides: { operationId?: string; operationDigest?: string } = {},
    ): Promise<Request> {
      const prepared = await prepareCommunityDeliveryEvents(inputEvents)
      if (!prepared.ok) throw new Error(`invalid fixture: ${prepared.reason}`)
      return new Request("http://internal/community-broadcast-bundle", {
        method: "POST",
        headers: { [INTERNAL_USER_TARGET_HEADER]: encodeURIComponent("user-42") },
        body: JSON.stringify({
          operationId: overrides.operationId ?? await deriveCommunityDeliveryOperationId("m-1"),
          operationDigest: overrides.operationDigest ?? prepared.prepared.digest,
          events: prepared.prepared.envelopes,
        }),
      })
    }

    it("rejects an invalid internal target before decoding the bundle", async () => {
      const { durable } = createDO()
      const response = await durable.fetch(new Request(
        "http://internal/community-broadcast-bundle",
        { method: "POST", body: "{}" },
      ))

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        status: "invalid",
        operationId: null,
        code: "invalid_request",
      })
    })

    it("sends one batch frame to every authenticated tab", async () => {
      const { durable, ctx } = createDO()
      const first = createMockWebSocket()
      const second = createMockWebSocket()
      first.serializeAttachment({
        type: "user",
        userId: "user-42",
        authenticated: true,
      })
      second.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([first, second])

      const response = await durable.fetch(await requestFor())

      expect(response.status).toBe(200)
      const receipt = await response.json() as CommunityDeliveryReceipt
      expect(receipt).toMatchObject({
        status: "complete",
        eventCount: 3,
        matched: 2,
        attempted: 2,
        enqueued: 2,
      })
      expect(first.send).toHaveBeenCalledTimes(1)
      expect(JSON.parse(first.send.mock.calls[0][0] as string)).toMatchObject({
        type: "community:events.batch",
        events: expect.any(Array),
      })
      expect(second.send).toHaveBeenCalledTimes(1)
      expect(JSON.parse(second.send.mock.calls[0][0] as string)).toMatchObject({
        type: "community:events.batch",
        events: expect.any(Array),
      })
      expect(first.deserializeAttachment()).toMatchObject({
        communityDeliveryProgress: [[expect.any(String), expect.any(String), 1, 1]],
      })
      expect(second.deserializeAttachment()).toMatchObject({
        communityDeliveryProgress: [[expect.any(String), expect.any(String), 1, 1]],
      })
    })

    it("sends zero frames when any event is invalid", async () => {
      const { durable, ctx } = createDO()
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])
      const prepared = await prepareCommunityDeliveryEvents(events)
      if (!prepared.ok) throw new Error("fixture must prepare")
      const response = await durable.fetch(new Request("http://internal/community-broadcast-bundle", {
        method: "POST",
        headers: { [INTERNAL_USER_TARGET_HEADER]: encodeURIComponent("user-42") },
        body: JSON.stringify({
          operationId: await deriveCommunityDeliveryOperationId("m-1"),
          operationDigest: prepared.prepared.digest,
          events: [...prepared.prepared.envelopes, { type: "community:unknown" }],
        }),
      }))

      expect(response.status).toBe(400)
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("suppresses a completed same-digest retry and rejects same-ID/different-digest before sends", async () => {
      const { durable, ctx } = createDO()
      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "user",
        userId: "user-42",
        authenticated: true,
      })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])

      expect((await durable.fetch(await requestFor())).status).toBe(200)
      expect(ws.send).toHaveBeenCalledTimes(1)
      const retry = await durable.fetch(await requestFor())
      expect(retry.status).toBe(200)
      await expect(retry.json()).resolves.toMatchObject({
        enqueued: 0,
        alreadyEnqueued: 1,
        attempted: 0,
      })
      expect(ws.send).toHaveBeenCalledTimes(1)

      const conflict = await durable.fetch(await requestFor(events.slice(0, 2)))
      expect(conflict.status).toBe(409)
      expect(ws.send).toHaveBeenCalledTimes(1)
    })

    it("records a successful tab, reports a sibling batch send failure, and retries only the sibling", async () => {
      const { durable, ctx } = createDO()
      const first = createMockWebSocket()
      first.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })
      const second = createMockWebSocket()
      second.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })
      second.send.mockImplementationOnce(() => { throw new Error("send failed") })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([first, second])

      const response = await durable.fetch(await requestFor())
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({
        attempted: 2,
        enqueued: 1,
        failed: 1,
        partial: 0,
        results: [
          { socketIndex: 0, outcome: "enqueued", persistedNextFrameIndex: 1, frameCount: 1 },
          { socketIndex: 1, outcome: "failed", persistedNextFrameIndex: 0, frameCount: 1 },
        ],
      })

      first.send.mockClear()
      second.send.mockReset()
      const retry = await durable.fetch(await requestFor())
      expect(retry.status).toBe(200)
      await expect(retry.json()).resolves.toMatchObject({ attempted: 1, enqueued: 1, alreadyEnqueued: 1 })
      expect(first.send).not.toHaveBeenCalled()
      expect(second.send).toHaveBeenCalledTimes(1)
      expect(JSON.parse(second.send.mock.calls[0][0] as string).type).toBe("community:events.batch")
    })

    it("aborts phase A for every socket when one attachment preflight fails", async () => {
      const { durable, ctx } = createDO()
      const ready = createMockWebSocket()
      ready.serializeAttachment({
        type: "user",
        userId: "user-42",
        authenticated: true,
      })
      const malformed = createMockWebSocket()
      malformed.serializeAttachment({
        type: "user",
        userId: "user-42",
        authenticated: true,
        communityDeliveryProgress: [["not-an-operation-id", "a".repeat(64), 0, 1]],
      })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ready, malformed])

      const response = await durable.fetch(await requestFor())
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({
        attempted: 0,
        enqueued: 0,
        preflightFailed: 1,
        notAttempted: 1,
        partial: 0,
        failed: 0,
        ambiguousClosed: 0,
        results: [
          { socketIndex: 0, outcome: "notAttempted" },
          { socketIndex: 1, outcome: "preflightFailed" },
        ],
      })
      expect(ready.send).not.toHaveBeenCalled()
      expect(malformed.send).not.toHaveBeenCalled()
    })

    it("fails phase A when stored frame metadata conflicts with the fixed batch frame", async () => {
      const { durable, ctx } = createDO()
      const ws = createMockWebSocket()
      const operationId = await deriveCommunityDeliveryOperationId("m-1")
      const prepared = await prepareCommunityDeliveryEvents(events)
      if (!prepared.ok) throw new Error("fixture must prepare")
      ws.serializeAttachment({
        type: "user",
        userId: "user-42",
        authenticated: true,
        communityDeliveryProgress: [[operationId, prepared.prepared.digest, 0, 3]],
      })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])

      const response = await durable.fetch(await requestFor())

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({
        preflightFailed: 1,
        results: [{ outcome: "preflightFailed" }],
      })
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("fails phase A when progress state becomes malformed during candidate construction", async () => {
      const { durable, ctx } = createDO()
      const ws = createMockWebSocket()
      let progressReads = 0
      const state = {
        type: "user" as const,
        userId: "user-42",
        authenticated: true,
        get communityDeliveryProgress() {
          progressReads += 1
          return progressReads === 1 ? undefined : [["invalid"]]
        },
      }
      ws.deserializeAttachment.mockReturnValue(state)
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])

      const response = await durable.fetch(await requestFor())

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({ preflightFailed: 1 })
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("fails phase A when the next persisted cursor would exceed the attachment budget", async () => {
      const { durable, ctx } = createDO()
      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "user",
        userId: "user-42",
        authenticated: true,
        name: "x".repeat(COMMUNITY_CONNECTION_STATE_JSON_MAX_BYTES),
      })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])

      const response = await durable.fetch(await requestFor())

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({ preflightFailed: 1 })
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("treats a batch encoder invariant fault as all-socket zero-send", async () => {
      const { durable, ctx } = createDO()
      const first = createMockWebSocket()
      first.serializeAttachment({
        type: "user",
        userId: "user-42",
        authenticated: true,
      })
      const second = createMockWebSocket()
      second.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([first, second])
      mockEncodePreparedCommunityBrowserEventBatch.mockReturnValueOnce({
        ok: false,
        reason: "batch-invariant-oversized",
        byteLength: 328_705,
      })

      const response = await durable.fetch(await requestFor())
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({
        attempted: 0,
        preflightFailed: 2,
        notAttempted: 0,
        results: [
          { socketIndex: 0, outcome: "preflightFailed", frameCount: 1 },
          { socketIndex: 1, outcome: "preflightFailed", frameCount: 1 },
        ],
      })
      expect(first.send).not.toHaveBeenCalled()
      expect(second.send).not.toHaveBeenCalled()
    })

    it("returns an exact complete zero-socket receipt", async () => {
      const { durable, ctx } = createDO()
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([])

      const response = await durable.fetch(await requestFor())
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        status: "complete",
        validated: true,
        matched: 0,
        attempted: 0,
        enqueued: 0,
        alreadyEnqueued: 0,
        preflightFailed: 0,
        notAttempted: 0,
        partial: 0,
        failed: 0,
        ambiguousClosed: 0,
        results: [],
      })
    })

    it("closes a socket and reports ambiguity when attachment persistence fails after send", async () => {
      const { durable, ctx } = createDO()
      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "user",
        userId: "user-42",
        authenticated: true,
      })
      ws.serializeAttachment.mockImplementationOnce(() => {
        throw new Error("attachment failed")
      })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])

      const response = await durable.fetch(await requestFor())
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({
        status: "incomplete",
        failed: 1,
        ambiguousClosed: 1,
        results: [{ persistedNextFrameIndex: 0, ambiguousClosed: true }],
      })
      expect(ws.send).toHaveBeenCalledTimes(1)
      expect(ws.close).toHaveBeenCalledWith(1011, "Delivery state unavailable")
    })
  })


  describe("fetch — WebSocket upgrade", () => {
    it("returns 101 for valid WebSocket upgrade", async () => {
      const { durable } = createDO()
      const req = new Request("http://internal/?userId=u1", {
        headers: { Upgrade: "websocket" },
      })

      const res = await durable.fetch(req)

      expect(res.status).toBe(101)
      expect((res as unknown as CFResponse).webSocket).toBeDefined()
    })

    it("returns 426 for non-WebSocket request", async () => {
      const { durable } = createDO()
      const req = new Request("http://internal/")

      const res = await durable.fetch(req)

      expect(res.status).toBe(426)
    })

    it("attaches an unauthenticated ConnectionState on upgrade", async () => {
      const { durable, ctx } = createDO()
      const req = new Request("http://internal/?userId=u1", {
        headers: { Upgrade: "websocket" },
      })

      await durable.fetch(req)

      const acceptCall = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0]
      const serverWs = acceptCall[0]
      expect(serverWs.deserializeAttachment()).toEqual({
        type: "user",
        userId: "",
        targetUserId: "u1",
        authenticated: false,
      })
    })
  })


  describe("webSocketMessage — auth flow", () => {
    it("authenticates with valid token and sends auth.ok", async () => {
      const { durable } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue({ userId: "user-42", name: "Ana", discriminator: "0012" })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "user",
        userId: "",
        targetUserId: "user-42",
        authenticated: false,
      })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "valid-token" }))

      expect(mockGetValidSessionWithIdentity).toHaveBeenCalledWith({}, "valid-token")
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "auth.ok" }))
      expect(ws.deserializeAttachment()).toEqual({
        type: "user",
        userId: "user-42",
        targetUserId: "user-42",
        authenticated: true,
        name: "Ana",
        discriminator: "0012",
      })
    })

    it("preserves delivery progress when an existing user socket reauthenticates", async () => {
      const { durable } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue({ userId: "user-42", name: "Ana", discriminator: "0012" })
      const operationId = await deriveCommunityDeliveryOperationId("message-reauth")
      const progress = [[operationId, "a".repeat(64), 1, 1]]
      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "user",
        userId: "user-42",
        targetUserId: "user-42",
        authenticated: true,
        communityDeliveryProgress: progress,
      })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "valid-token" }))

      expect(ws.deserializeAttachment()).toMatchObject({
        type: "user",
        userId: "user-42",
        authenticated: true,
        communityDeliveryProgress: progress,
      })
    })

    it("retries a transient session lookup before authenticating", async () => {
      const { durable } = createDO()
      mockGetValidSessionWithIdentity
        .mockRejectedValueOnce(new Error("SQLITE_BUSY"))
        .mockResolvedValueOnce({ userId: "user-42", name: "Ana", discriminator: "0012" })
      mockWithD1Retry.mockImplementation(async (fn) => {
        try {
          return await fn()
        } catch {
          return fn()
        }
      })
      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "user",
        userId: "",
        targetUserId: "user-42",
        authenticated: false,
      })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "valid-token" }))

      expect(mockWithD1Retry).toHaveBeenCalledWith(expect.any(Function), {
        route: "ws-do:user-auth-session",
      })
      expect(mockGetValidSessionWithIdentity).toHaveBeenCalledTimes(2)
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "auth.ok" }))
      expect(ws.close).not.toHaveBeenCalled()
    })

    it("first authenticated user connection broadcasts online presence and starts a snapshot", async () => {
      const { durable } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue({ userId: "user-42", name: "Ana", discriminator: "0012" })
      mockGetCoMemberUserIds.mockResolvedValue(["friend-1"])
      mockStubFetch.mockImplementation(async (request: Request) =>
        new (globalThis.Response as any)(
          request.url.includes("/check-user-online")
            ? JSON.stringify({ online: false })
            : JSON.stringify({ sent: 1 }),
        ),
      )
      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "user",
        userId: "",
        targetUserId: "user-42",
        authenticated: false,
      })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "valid-token" }))
      await flushAsyncWork()

      const requests = mockStubFetch.mock.calls.map(([request]) => request as Request)
      expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/community-broadcast"))).toBe(true)
      expect(requests.some((request) => request.method === "GET" && request.url.includes("/check-user-online"))).toBe(true)
    })

    it("second authenticated user connection does not duplicate the online presence transition", async () => {
      const { durable, ctx } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue({ userId: "user-42", name: "Ana", discriminator: "0012" })
      mockGetCoMemberUserIds.mockResolvedValue(["friend-1"])
      mockStubFetch.mockResolvedValue(new (globalThis.Response as any)(JSON.stringify({ online: false })))
      const existing = createMockWebSocket()
      existing.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([existing])
      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "user",
        userId: "",
        targetUserId: "user-42",
        authenticated: false,
      })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "valid-token" }))
      await flushAsyncWork()

      const requests = mockStubFetch.mock.calls.map(([request]) => request as Request)
      expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/broadcast"))).toBe(false)
      expect(requests.some((request) => request.method === "GET" && request.url.includes("/check-user-online"))).toBe(true)
    })

    it("closes an attacker token before auth.ok across router and victim-target DO", async () => {
      const { durable, ctx, env } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue({
        userId: "attacker",
        name: "Attacker",
        discriminator: "0066",
      })
      ;(env.WS_DO.get as ReturnType<typeof vi.fn>).mockReturnValue({
        fetch: (request: Request) => durable.fetch(request),
      })
      const request = new Request("http://localhost/?userId=victim", {
        headers: { Upgrade: "websocket" },
      })
      const requestLog = { info: vi.fn() }

      await handleUpgrade({
        request,
        env,
        url: new URL(request.url),
        traceId: "trace-pr0",
        log: { child: vi.fn(() => requestLog) } as any,
      })
      const accepted = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0][0]

      await durable.webSocketMessage(
        accepted,
        JSON.stringify({ type: "auth", token: "attacker-session-token" }),
      )
      await flushAsyncWork()

      expect(accepted.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(accepted.send).not.toHaveBeenCalled()
      expect(mockGetCoMemberUserIds).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
      expect(env.WS_DO.idFromName).toHaveBeenCalledWith("user:victim")
      expect(mockLogWarn).toHaveBeenCalledWith("user websocket target mismatch", {
        source: "auth",
        targetUserId: "victim",
        authenticatedUserId: "attacker",
      })
      expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain("attacker-session-token")
    })

    it("invalidates a historical authenticated mismatch before re-auth close", async () => {
      const { durable, ctx } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue({
        userId: "attacker",
        name: "Attacker",
        discriminator: "0066",
      })
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "attacker", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", token: "attacker-session-token" }),
      )

      expect(ws.deserializeAttachment()).toEqual({
        type: "user",
        userId: "attacker",
        authenticated: false,
      })
      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")

      await durable.webSocketClose(ws as any)
      await flushAsyncWork()

      expect(mockGetCoMemberUserIds).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("keeps a correctly bound socket authenticated until mismatch close handling", async () => {
      const { durable, ctx } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue({
        userId: "attacker",
        name: "Attacker",
        discriminator: "0066",
      })
      mockGetCoMemberUserIds.mockResolvedValue(["friend-1"])
      mockStubFetch.mockResolvedValue(
        new (globalThis.Response as any)(JSON.stringify({ sent: 1 })),
      )
      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "user",
        userId: "victim",
        targetUserId: "victim",
        authenticated: true,
      })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", token: "attacker-session-token" }),
      )

      expect(ws.deserializeAttachment()).toEqual({
        type: "user",
        userId: "victim",
        targetUserId: "victim",
        authenticated: true,
      })

      await durable.webSocketClose(ws as any)
      await flushAsyncWork()

      const [request] = mockStubFetch.mock.calls[0] as [Request]
      expect(await request.clone().json()).toEqual({
        type: "community:presence.update",
        userId: "victim",
        online: false,
      })
    })

    it("closes with 1008 on invalid token", async () => {
      const { durable } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "bad" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(ws.send).not.toHaveBeenCalled()
      expect(mockGetValidSessionWithIdentity).toHaveBeenCalledTimes(1)
    })

    it("closes with 1008 when auth message has no token", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(ws.send).not.toHaveBeenCalled()
      expect(mockGetValidSession).not.toHaveBeenCalled()
    })

    it("closes with 1008 when auth message has empty string token", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(ws.send).not.toHaveBeenCalled()
      expect(mockGetValidSession).not.toHaveBeenCalled()
    })

    it("closes unauthenticated connection sending non-auth message", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "some-event" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Not authenticated")
    })

    it("closes with 1008 when session token is expired (getValidSession returns null)", async () => {
      const { durable } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "expired-token" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.deserializeAttachment()).toEqual({ type: "user", userId: "", authenticated: false })
    })

    it("closes on invalid JSON", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()

      await durable.webSocketMessage(ws as any, "not-json")

      expect(ws.close).toHaveBeenCalledWith(1008, "Invalid JSON")
    })

    it("ignores binary messages", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()

      await durable.webSocketMessage(ws as any, new ArrayBuffer(4))

      expect(ws.close).not.toHaveBeenCalled()
      expect(ws.send).not.toHaveBeenCalled()
    })
  })


  describe("webSocketMessage — daemon auth flow", () => {
    it("rejects daemon with pending token (not yet activated)", async () => {
      const { durable } = createDO()
      mockGetMachineTokenByToken.mockResolvedValue({
        id: "mt_1", userId: "u1", status: "pending", workspaceId: null,
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", userId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "al_pending123", daemonId: "my-daemon" }),
      )

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(mockGetRuntimeIdsByDaemon).not.toHaveBeenCalled()
    })

    it("authenticates daemon with active token (no runtime check in auth)", async () => {
      const { durable } = createDO()
      mockGetMachineTokenByToken.mockResolvedValue({
        id: "mt_1", userId: "u1", status: "active", workspaceId: "sp_ws1",
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "al_active123", daemonId: "my-daemon" }),
      )

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "auth.ok" }))
      // Runtime presence is no longer part of auth — it must not gate the WS
      // connection (tasks route by workspaceId; runtimes may be mid-register).
      expect(mockGetRuntimeIdsByDaemon).not.toHaveBeenCalled()
    })

    it("authenticates daemon with active token even when it has no runtimes yet", async () => {
      const { durable } = createDO()
      mockGetMachineTokenByToken.mockResolvedValue({
        id: "mt_1", userId: "u1", status: "active", workspaceId: "sp_ws1",
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "al_noruntimes", daemonId: "my-daemon" }),
      )

      // No-runtime is a valid state (not an auth failure) — auth.ok, no reject.
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "auth.ok" }))
      expect(ws.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "error", code: "AUTH_REJECTED" }))
    })

    it("sends AUTH_REJECTED then closes on definitely-invalid token", async () => {
      const { durable } = createDO()
      mockGetMachineTokenByToken.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "al_dead", daemonId: "my-daemon" }),
      )

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "error", code: "AUTH_REJECTED" }))
      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
    })

    it("closes WITHOUT AUTH_REJECTED on transient D1 failure (daemon must retry)", async () => {
      const { durable } = createDO()
      mockGetMachineTokenByToken.mockRejectedValue(new Error("D1 unavailable"))

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "al_blip", daemonId: "my-daemon" }),
      )

      expect(ws.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "error", code: "AUTH_REJECTED" }))
      expect(ws.close).toHaveBeenCalledWith(1011, "Auth temporarily unavailable")
    })

    it("rejects daemon with unknown token", async () => {
      const { durable } = createDO()
      mockGetMachineTokenByToken.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "al_unknown", daemonId: "my-daemon" }),
      )

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
    })

    it("rejects daemon with non-al_ prefixed token", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "bad_prefix", daemonId: "my-daemon" }),
      )

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(mockGetMachineTokenByToken).not.toHaveBeenCalled()
    })
  })


  describe("webSocketMessage — check_daemon_status (cross-DO)", () => {
    it("returns runtime.status online when daemon DO reports alive", async () => {
      const { durable, env } = createDO()
      mockGetLatestTokenForUser.mockResolvedValue({ hostname: "MyMachine.local" })

      const aliveStub = { fetch: vi.fn().mockResolvedValue(new (globalThis.Response as any)(JSON.stringify({ alive: true }))) }
        ; (env.WS_DO as any).get = vi.fn().mockReturnValue(aliveStub)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "check_daemon_status" }))

      expect((env.WS_DO as any).idFromName).toHaveBeenCalledWith("daemon:MyMachine.local")
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "runtime.status", status: "online", daemonId: "MyMachine.local" }),
      )
    })

    it("does not respond when daemon DO reports not alive", async () => {
      const { durable, env } = createDO()
      mockGetLatestTokenForUser.mockResolvedValue({ hostname: "MyMachine.local" })

      const deadStub = { fetch: vi.fn().mockResolvedValue(new (globalThis.Response as any)(JSON.stringify({ alive: false }))) }
        ; (env.WS_DO as any).get = vi.fn().mockReturnValue(deadStub)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "check_daemon_status" }))

      expect(ws.send).not.toHaveBeenCalled()
    })

    it("does not respond when no token/hostname found", async () => {
      const { durable } = createDO()
      mockGetLatestTokenForUser.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "check_daemon_status" }))

      expect(ws.send).not.toHaveBeenCalled()
    })

    it("does not respond when the daemon durable object fetch rejects", async () => {
      const { durable, env } = createDO()
      mockGetLatestTokenForUser.mockResolvedValue({ hostname: "MyMachine.local" })
      ;(env.WS_DO as any).get = vi.fn().mockReturnValue({
        fetch: vi.fn().mockRejectedValue(new Error("daemon DO unavailable")),
      })
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "check_daemon_status" }))

      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.close).not.toHaveBeenCalled()
    })
  })


  describe("webSocketError", () => {
    it("closes with 1011", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()

      await durable.webSocketError(ws as any, new Error("boom"))

      expect(ws.close).toHaveBeenCalledWith(1011, "Internal error")
    })
  })


  describe("webSocketClose — user and daemon characterization", () => {
    it("keeps user presence online while another authenticated tab remains", async () => {
      const { durable, ctx } = createDO()
      const closing = createMockWebSocket()
      closing.serializeAttachment({ type: "user", userId: "user-1", authenticated: true })
      const other = createMockWebSocket()
      other.serializeAttachment({ type: "user", userId: "user-1", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([closing, other])

      await durable.webSocketClose(closing as any)
      await flushAsyncWork()

      expect(mockGetCoMemberUserIds).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("broadcasts offline presence when the last authenticated user tab closes", async () => {
      const { durable, ctx } = createDO()
      mockGetCoMemberUserIds.mockResolvedValue(["friend-1"])
      mockStubFetch.mockResolvedValue(new (globalThis.Response as any)(JSON.stringify({ sent: 1 })))
      const closing = createMockWebSocket()
      closing.serializeAttachment({ type: "user", userId: "user-1", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([closing])

      await durable.webSocketClose(closing as any)
      await flushAsyncWork()

      const [request] = mockStubFetch.mock.calls[0] as [Request]
      expect(await request.clone().json()).toEqual({
        type: "community:presence.update",
        userId: "user-1",
        online: false,
      })
    })

    it("reports daemon offline and swallows a rejected owner notification", async () => {
      const { durable } = createDO()
      mockStubFetch.mockRejectedValue(new Error("owner DO unavailable"))
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "daemon-1", userId: "user-1", authenticated: true })

      await expect(durable.webSocketClose(ws as any)).resolves.toBeUndefined()
      await flushAsyncWork()

      expect(mockStubFetch).toHaveBeenCalledTimes(1)
      const [request] = mockStubFetch.mock.calls[0] as [Request]
      expect(await request.clone().json()).toEqual({
        type: "runtime.status",
        status: "offline",
        daemonId: "daemon-1",
      })
    })
  })
})
