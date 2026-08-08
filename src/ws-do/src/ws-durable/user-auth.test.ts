import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMockWebSocket } from "../__mocks__/cf"
import {
  CFResponse,
  cleanupHarness,
  createDO,
  flushAsyncWork,
  mockCheckAliveFetch,
  mockCreateDb,
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
  mockReconcileBotActivityFromRunningAgents,
  mockResolveScopeMemberUserIds,
  mockStubFetch,
  mockToSummary,
  mockTouchBotRefreshContext,
  mockTouchMachineHeartbeat,
  mockUpdateProfile,
  mockUpsertMachineByMachineId,
  resetHarness
} from "./test-harness"

describe("WebSocketDurableObject", () => {
  beforeEach(() => resetHarness())
  afterEach(() => cleanupHarness())


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
      expect(serverWs.deserializeAttachment()).toEqual({ type: "user", userId: "", authenticated: false })
    })
  })


  describe("webSocketMessage — auth flow", () => {
    it("authenticates with valid token and sends auth.ok", async () => {
      const { durable } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue({ userId: "user-42", name: "Ana", discriminator: "0012" })

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "valid-token" }))

      expect(mockGetValidSessionWithIdentity).toHaveBeenCalledWith({}, "valid-token")
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "auth.ok" }))
      expect(ws.deserializeAttachment()).toEqual({ type: "user", userId: "user-42", authenticated: true, name: "Ana", discriminator: "0012" })
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
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "valid-token" }))
      await flushAsyncWork()

      const requests = mockStubFetch.mock.calls.map(([request]) => request as Request)
      expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/broadcast"))).toBe(true)
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
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "valid-token" }))
      await flushAsyncWork()

      const requests = mockStubFetch.mock.calls.map(([request]) => request as Request)
      expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/broadcast"))).toBe(false)
      expect(requests.some((request) => request.method === "GET" && request.url.includes("/check-user-online"))).toBe(true)
    })

    it("closes with 1008 on invalid token", async () => {
      const { durable } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "bad" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(ws.send).not.toHaveBeenCalled()
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
