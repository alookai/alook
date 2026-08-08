import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
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
  mockResolveChannelRecipientUserIds,
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


  describe("fetch — broadcast", () => {
    it("sends message to all authenticated connections", async () => {
      const { durable, ctx } = createDO()

      // Set up two WebSockets: one authenticated, one not
      const wsAuth = createMockWebSocket()
      wsAuth.serializeAttachment({ type: "user", userId: "u1", authenticated: true })
      const wsUnauth = createMockWebSocket()
      wsUnauth.serializeAttachment({ type: "user", userId: "", authenticated: false })
        ; (ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([wsAuth, wsUnauth])

      const req = new Request("http://internal/broadcast", {
        method: "POST",
        body: JSON.stringify({ type: "runtime.status", daemonId: "d1", workspaceId: "w1", status: "online" }),
      })

      const res = await durable.fetch(req)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 1 })
      expect(wsAuth.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "runtime.status", daemonId: "d1", workspaceId: "w1", status: "online" })
      )
      expect(wsUnauth.send).not.toHaveBeenCalled()
    })

    it("returns sent: 0 when no connections exist", async () => {
      const { durable, ctx } = createDO()
        ; (ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([])

      const req = new Request("http://internal/broadcast", {
        method: "POST",
        body: '{"type":"test"}',
      })

      const res = await durable.fetch(req)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
    })

    it("skips connections that throw on send (already closed)", async () => {
      const { durable, ctx } = createDO()

      const wsOpen = createMockWebSocket(WebSocket.OPEN)
      wsOpen.serializeAttachment({ type: "user", userId: "u1", authenticated: true })
      const wsClosed = createMockWebSocket(WebSocket.CLOSED)
      wsClosed.serializeAttachment({ type: "user", userId: "u1", authenticated: true })
      wsClosed.send.mockImplementation(() => { throw new Error("Connection closed") })
        ; (ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([wsOpen, wsClosed])

      const req = new Request("http://internal/broadcast", {
        method: "POST",
        body: '{"type":"test"}',
      })

      const res = await durable.fetch(req)

      expect(wsOpen.send).toHaveBeenCalled()
      expect(wsClosed.send).toHaveBeenCalled()
      expect(await res.json()).toEqual({ sent: 1 })
    })
  })


  describe("fetch — /check-alive characterization", () => {
    it("reports alive only when an authenticated daemon socket is attached", async () => {
      const { durable, ctx } = createDO()
      const daemon = createMockWebSocket()
      daemon.serializeAttachment({ type: "daemon", daemonId: "daemon-1", userId: "user-1", authenticated: true })
      const user = createMockWebSocket()
      user.serializeAttachment({ type: "user", userId: "user-1", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([user, daemon])

      const response = await durable.fetch(new Request("http://internal/check-alive"))

      expect(await response.json()).toEqual({ alive: true })
    })

    it("reports not alive for unauthenticated daemon and authenticated non-daemon attachments", async () => {
      const { durable, ctx } = createDO()
      const daemon = createMockWebSocket()
      daemon.serializeAttachment({ type: "daemon", daemonId: "daemon-1", userId: "user-1", authenticated: false })
      const machine = createMockWebSocket()
      machine.serializeAttachment({ type: "community-machine", machineId: "machine-1", userId: "user-1", authenticated: true })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([daemon, machine])

      const response = await durable.fetch(new Request("http://internal/check-alive"))

      expect(await response.json()).toEqual({ alive: false })
    })
  })


  describe("fetch — /check-user-online (bot-aware, keyed by ?userId=)", () => {
    // This DO instance is keyed by `user:<id>` (idFromName) but can't read
    // its own name back off `ctx` on this worker's pinned compatibility_date
    // — see plans/community-account-debt-fixes.md Fix 3 — so every caller
    // passes `?userId=` explicitly and the handler branches on it.
    it("answers via isBotOnline for a bot id, bypassing the live-socket check entirely", async () => {
      const { durable, ctx } = createDO()
      mockGetUserInternal.mockResolvedValue({ isBot: true } as any)
      mockIsBotOnline.mockResolvedValue(true)
        ; (ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([])

      const res = await durable.fetch(new Request("http://internal/check-user-online?userId=bot-1"))

      expect(await res.json()).toEqual({ online: true })
      expect(mockGetUserInternal).toHaveBeenCalledWith({}, "bot-1")
      expect(mockIsBotOnline).toHaveBeenCalledWith({}, "bot-1")
    })

    it("answers false for a bot id with no bound machine or an offline one", async () => {
      const { durable } = createDO()
      mockGetUserInternal.mockResolvedValue({ isBot: true } as any)
      mockIsBotOnline.mockResolvedValue(false)

      const res = await durable.fetch(new Request("http://internal/check-user-online?userId=bot-1"))

      expect(await res.json()).toEqual({ online: false })
    })

    it("falls back to the live-socket check for a human id (regression: query-param change must not break humans)", async () => {
      const { durable, ctx } = createDO()
      mockGetUserInternal.mockResolvedValue({ isBot: false } as any)
      const wsAuth = createMockWebSocket()
      wsAuth.serializeAttachment({ type: "user", userId: "human-1", authenticated: true })
        ; (ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([wsAuth])

      const res = await durable.fetch(new Request("http://internal/check-user-online?userId=human-1"))

      expect(await res.json()).toEqual({ online: true })
      expect(mockIsBotOnline).not.toHaveBeenCalled()
    })

    it("falls back to the live-socket check when userId is missing entirely", async () => {
      const { durable, ctx } = createDO()
      const wsAuth = createMockWebSocket()
      wsAuth.serializeAttachment({ type: "user", userId: "u1", authenticated: true })
        ; (ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([wsAuth])

      const res = await durable.fetch(new Request("http://internal/check-user-online"))

      expect(await res.json()).toEqual({ online: true })
      expect(mockGetUserInternal).not.toHaveBeenCalled()
    })

    it("degrades to { online: false, stale: true } when D1 throws on the bot-online lookup", async () => {
      // Fail-closed via `readOrStale`: getUserInternal (or isBotOnline)
      // throwing on retry-exhaust must NOT surface as a 500 — the caller
      // reads `{ online: false, stale: true }` and moves on.
      const { durable } = createDO()
      mockGetUserInternal.mockRejectedValue(new Error("D1 down"))

      const res = await durable.fetch(new Request("http://internal/check-user-online?userId=bot-1"))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ online: false, stale: true })
    })
  })


  describe("presence audience — co-members ∪ friends (deduped)", () => {
    // Presence fan-out must reach friends who share no server, not just
    // co-members — that's the whole point of a friends list. Exercised
    // directly against the private helper/methods (bypassing the
    // fire-and-forget `.catch(() => {})` call sites in the auth flow) so
    // these assertions aren't racing an un-awaited promise.
    type PresenceInternals = {
      getPresenceAudience(userId: string): Promise<string[]>
      broadcastPresence(userId: string, online: boolean): Promise<void>
      sendPresenceSnapshot(ws: WebSocket, userId: string): Promise<void>
    }

    it("getPresenceAudience merges co-members and friends without duplicates", async () => {
      const { durable } = createDO()
      mockGetCoMemberUserIds.mockResolvedValue(["member-a", "shared-b"])
      mockGetFriendUserIds.mockResolvedValue(["shared-b", "friend-c"])

      const audience = await (durable as unknown as PresenceInternals).getPresenceAudience("user-1")

      expect(new Set(audience)).toEqual(new Set(["member-a", "shared-b", "friend-c"]))
      expect(audience).toHaveLength(3)
      expect(mockGetCoMemberUserIds).toHaveBeenCalledWith({}, "user-1")
      expect(mockGetFriendUserIds).toHaveBeenCalledWith({}, "user-1")
    })

    it("getPresenceAudience returns [] when the user has no co-members and no friends", async () => {
      const { durable } = createDO()
      mockGetCoMemberUserIds.mockResolvedValue([])
      mockGetFriendUserIds.mockResolvedValue([])

      const audience = await (durable as unknown as PresenceInternals).getPresenceAudience("user-1")

      expect(audience).toEqual([])
    })

    it("broadcastPresence fans out to a friend who shares no server", async () => {
      const { durable, env } = createDO()
      mockGetCoMemberUserIds.mockResolvedValue([])
      mockGetFriendUserIds.mockResolvedValue(["friend-c"])
      mockStubFetch.mockClear()

      await (durable as unknown as PresenceInternals).broadcastPresence("user-1", true)

      expect(env.WS_DO.idFromName).toHaveBeenCalledWith("user:friend-c")
      expect(mockStubFetch).toHaveBeenCalledTimes(1)
      const [req] = mockStubFetch.mock.calls[0] as [Request]
      expect(req.url).toBe("http://internal/broadcast")
    })

    it("broadcastPresence no-ops (no fetches) when co-members and friends are both empty", async () => {
      const { durable } = createDO()
      mockGetCoMemberUserIds.mockResolvedValue([])
      mockGetFriendUserIds.mockResolvedValue([])
      mockStubFetch.mockClear()

      await (durable as unknown as PresenceInternals).broadcastPresence("user-1", true)

      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("sendPresenceSnapshot reports an online friend who shares no server", async () => {
      const { durable } = createDO()
      mockGetCoMemberUserIds.mockResolvedValue([])
      mockGetFriendUserIds.mockResolvedValue(["friend-c"])
      mockStubFetch.mockResolvedValue(
        new (globalThis.Response as any)(JSON.stringify({ online: true })),
      )
      const ws = createMockWebSocket()

      await (durable as unknown as PresenceInternals).sendPresenceSnapshot(ws as any, "user-1")

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "community:presence.update", userId: "friend-c", online: true }),
      )
    })

    it("authentication snapshot sends only fulfilled non-stale online audience entries", async () => {
      const { durable, env } = createDO()
      mockGetValidSessionWithIdentity.mockResolvedValue({ userId: "user-1", name: "User", discriminator: "0001" })
      mockGetCoMemberUserIds.mockResolvedValue(["online", "offline", "stale", "rejected"])
      ;(env.WS_DO.idFromName as ReturnType<typeof vi.fn>).mockImplementation((name: string) => name)
      ;(env.WS_DO.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) => ({
        fetch: vi.fn(async (request: Request) => {
          if (request.method === "POST") {
            return new (globalThis.Response as any)(JSON.stringify({ sent: 1 }))
          }
          if (id === "user:online") {
            return new (globalThis.Response as any)(JSON.stringify({ online: true }))
          }
          if (id === "user:offline") {
            return new (globalThis.Response as any)(JSON.stringify({ online: false }))
          }
          if (id === "user:stale") {
            return new (globalThis.Response as any)(JSON.stringify({ online: false, stale: true }))
          }
          throw new Error("unreachable user DO")
        }),
      }))
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "valid-token" }))
      await flushAsyncWork()

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "auth.ok" }))
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "community:presence.update", userId: "online", online: true }),
      )
      expect(ws.send).toHaveBeenCalledTimes(2)
    })

    // Regression (post-Fix-3 hotfix): a fresh bot has no server membership,
    // so co-members alone can be empty for it even while its bound machine
    // is genuinely online. The fix lives one layer down, in
    // `getFriendUserIds` itself (see `community-friendship.test.ts`) — the
    // owner↔own-bot implicit friendship it already returns for `listFriends`
    // /`areFriends` now also flows through here, so `getPresenceAudience`
    // needs no bot-specific branch at all; it just trusts whatever
    // `getFriendUserIds` (mocked as `mockGetFriendUserIds` above) says.
  })


  describe("notifyUserDO — bot fan-out on community:machine.status (Fix 3)", () => {
    // `notifyUserDO` is private; every `community:machine.status` emission in
    // this file funnels through it (the single choke point the plan calls
    // for), so exercising it directly here covers all 5 call sites without
    // duplicating their individual setup.
    type NotifyInternals = { notifyUserDO(userId: string, payload: unknown): Promise<void> }

    /** Collects `{ url, body }` for every `mockStubFetch` call so far. */
    async function capturedRequests(): Promise<Array<{ url: string; body: string }>> {
      return Promise.all(
        mockStubFetch.mock.calls.map(async ([req]) => ({
          url: (req as Request).url,
          body: await (req as Request).clone().text(),
        }))
      )
    }

    it("fans out community:presence.update(online: true) to every bot bound to the machine, beyond the owner notify", async () => {
      const { durable, env } = createDO()
      mockListBotsForMachine.mockResolvedValue([
        { id: "bot-1", name: "Bot One", discriminator: "0001", description: "" },
        { id: "bot-2", name: "Bot Two", discriminator: "0002", description: "" },
      ])
      mockGetCoMemberUserIds.mockResolvedValue(["viewer-1"])
      mockGetFriendUserIds.mockResolvedValue([])
      mockStubFetch.mockClear()

      await (durable as unknown as NotifyInternals).notifyUserDO("owner-1", {
        type: "community:machine.status",
        machineId: "m1",
        status: "online",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      })

      expect(mockListBotsForMachine).toHaveBeenCalledWith({}, "m1")
      expect(env.WS_DO.idFromName).toHaveBeenCalledWith("user:owner-1")
      expect(env.WS_DO.idFromName).toHaveBeenCalledWith("user:viewer-1")

      const requests = await capturedRequests()
      // 1 owner notify (raw payload) + 1 broadcastPresence fetch per bot to the shared viewer.
      expect(requests).toHaveLength(3)
      expect(requests.filter((r) => r.body.includes('"userId":"bot-1"') && r.body.includes('"online":true'))).toHaveLength(1)
      expect(requests.filter((r) => r.body.includes('"userId":"bot-2"') && r.body.includes('"online":true'))).toHaveLength(1)
    })

    it("broadcasts online: false for every bound bot on a machine-offline transition", async () => {
      const { durable } = createDO()
      mockListBotsForMachine.mockResolvedValue([
        { id: "bot-1", name: "Bot One", discriminator: "0001", description: "" },
      ])
      mockGetCoMemberUserIds.mockResolvedValue(["viewer-1"])
      mockGetFriendUserIds.mockResolvedValue([])
      mockStubFetch.mockClear()

      await (durable as unknown as NotifyInternals).notifyUserDO("owner-1", {
        type: "community:machine.status",
        machineId: "m1",
        status: "offline",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      })

      const requests = await capturedRequests()
      expect(requests.some((r) => r.body.includes('"userId":"bot-1"') && r.body.includes('"online":false'))).toBe(true)
    })

    it("a machine bound to zero bots triggers no extra broadcast beyond the owner notify", async () => {
      const { durable } = createDO()
      mockListBotsForMachine.mockResolvedValue([])
      mockStubFetch.mockClear()

      await (durable as unknown as NotifyInternals).notifyUserDO("owner-1", {
        type: "community:machine.status",
        machineId: "m1",
        status: "online",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      })

      expect(mockStubFetch).toHaveBeenCalledTimes(1) // owner notify only
    })

    it("does not call listBotsForMachine for a payload that isn't a community:machine.status transition", async () => {
      const { durable } = createDO()
      mockStubFetch.mockClear()

      await (durable as unknown as NotifyInternals).notifyUserDO("owner-1", {
        type: "community:machine.updated",
        machine: { id: "m1" },
      })

      expect(mockListBotsForMachine).not.toHaveBeenCalled()
      expect(mockStubFetch).toHaveBeenCalledTimes(1) // owner notify only
    })

    it("does not throw and skips the bot fan-out on a malformed/non-object payload", async () => {
      const { durable } = createDO()
      await expect(
        (durable as unknown as NotifyInternals).notifyUserDO("owner-1", "not-an-object")
      ).resolves.toBeUndefined()
      expect(mockListBotsForMachine).not.toHaveBeenCalled()
    })

    it("resolves cleanly when the owner-notify stub fetch rejects — the whole method is under try/catch, callers never see the throw", async () => {
      // Regression guard: the owner-notify `userStub.fetch(...)` used to
      // sit OUTSIDE the method's try/catch. A stub-fetch throw would
      // propagate through every caller's `.catch(() => {})` and skip the
      // bot fan-out entirely, contradicting the comment that claims the
      // failure would "at least be visible."
      const { durable } = createDO()
      mockStubFetch.mockClear()
      // First call is the owner notify — reject it. Subsequent calls
      // (bot fan-out per-audience-member) should still fire.
      mockStubFetch.mockRejectedValueOnce(new Error("stub unreachable"))
      mockListBotsForMachine.mockResolvedValue([
        { id: "bot-1", name: "Bot One", discriminator: "0001", description: "" },
      ])
      mockGetCoMemberUserIds.mockResolvedValue(["viewer-1"])
      mockGetFriendUserIds.mockResolvedValue([])

      await expect(
        (durable as unknown as NotifyInternals).notifyUserDO("owner-1", {
          type: "community:machine.status",
          machineId: "m1",
          status: "online",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        })
      ).resolves.toBeUndefined()

      // Owner notify was attempted (and failed) — bot fan-out still ran.
      expect(mockListBotsForMachine).toHaveBeenCalledWith({}, "m1")
      // Owner notify + at least one broadcastPresence fetch to viewer-1.
      expect(mockStubFetch.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })


  describe("webSocketMessage — community:typing.start authz (fanOutTyping)", () => {
    // fanOutTyping runs fire-and-forget (`.catch()`, not awaited) inside
    // webSocketMessage, so `await durable.webSocketMessage(...)` alone
    // doesn't guarantee its internal DB-then-broadcast chain has settled.
    // Flush a macrotask so all pending microtasks (getDM/getChannelForMember
    // → listMembers → Promise.all(fetch)) drain before asserting.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

    it("does nothing when a typing frame has no channelId", async () => {
      const { durable } = createDO()
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "sender-1", authenticated: true })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "community:typing.start" }),
      )
      await flush()

      expect(mockGetChannelForMember).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("deduplicates the same user and scope inside eight seconds and accepts the boundary", async () => {
      const { durable } = createDO()
      mockGetChannelForMember.mockResolvedValue({ id: "channel-1", serverId: "server-1" })
      mockResolveScopeMemberUserIds.mockResolvedValue(["sender-1", "recipient-1"])
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "sender-1", authenticated: true })
      const now = vi.spyOn(Date, "now")
      try {
        now.mockReturnValue(10_000)
        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({ type: "community:typing.start", channelId: "channel-1" }),
        )
        await flushAsyncWork()
        now.mockReturnValue(17_999)
        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({ type: "community:typing.start", channelId: "channel-1" }),
        )
        await flushAsyncWork()
        now.mockReturnValue(18_000)
        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({ type: "community:typing.start", channelId: "channel-1" }),
        )
        await flushAsyncWork()

        expect(mockStubFetch).toHaveBeenCalledTimes(2)
      } finally {
        now.mockRestore()
      }
    })

    it("prunes only all-stale typing scopes after the map grows beyond two hundred", async () => {
      const { durable } = createDO()
      mockGetChannelForMember.mockResolvedValue(null)
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "sender-1", authenticated: true })
      let timestamp = 100_000
      const now = vi.spyOn(Date, "now").mockImplementation(() => timestamp)
      try {
        for (let index = 0; index < 200; index++) {
          await durable.webSocketMessage(
            ws as any,
            JSON.stringify({ type: "community:typing.start", channelId: `stale-${index}` }),
          )
        }
        timestamp = 140_001
        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({ type: "community:typing.start", channelId: "current" }),
        )

        const typingDedup = (durable as unknown as {
          typingDedup: Map<string, Map<string, number>>
        }).typingDedup
        expect([...typingDedup.keys()]).toEqual(["current"])
        expect(typingDedup.get("current")?.get("sender-1")).toBe(140_001)
      } finally {
        now.mockRestore()
      }
    })

    it("does not fan out or broadcast when sender is not a member of the target channel", async () => {
      const { durable, env } = createDO()
      mockGetChannelForMember.mockResolvedValueOnce(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "attacker", authenticated: true })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "community:typing.start", channelId: "chan-private" }),
      )
      await flush()

      expect(mockGetChannelForMember).toHaveBeenCalledWith(expect.anything(), "chan-private", "attacker")
      expect(mockResolveChannelRecipientUserIds).not.toHaveBeenCalled()
      expect(mockListMembers).not.toHaveBeenCalled()
      expect((env.WS_DO as any).get).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("fans out to other server members when sender IS a channel member", async () => {
      const { durable, env } = createDO()
      mockGetChannelForMember.mockResolvedValueOnce({ id: "chan-1", serverId: "server-1" })
      // Recipient resolution now goes through the shared member resolver — a
      // public channel resolves to every server member (sender included).
      mockResolveScopeMemberUserIds.mockResolvedValueOnce(["member-1", "member-2", "sender-1"])

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "sender-1", authenticated: true })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "community:typing.start", channelId: "chan-1" }),
      )
      await flush()

      expect(mockGetChannelForMember).toHaveBeenCalledWith(expect.anything(), "chan-1", "sender-1")
      expect(mockResolveScopeMemberUserIds).toHaveBeenCalledWith(expect.anything(), {
        scope: "channel",
        scopeId: "chan-1",
      })
      expect(mockResolveChannelRecipientUserIds).toHaveBeenCalledWith(expect.anything(), "chan-1")
      // Sender is excluded from recipients — only the other 2 members get a broadcast POST.
      expect((env.WS_DO as any).idFromName).toHaveBeenCalledWith("user:member-1")
      expect((env.WS_DO as any).idFromName).toHaveBeenCalledWith("user:member-2")
      expect((env.WS_DO as any).idFromName).not.toHaveBeenCalledWith("user:sender-1")
      expect(mockStubFetch).toHaveBeenCalledTimes(2)
    })

    it("private channel: fans out to the channel audience, not all server members", async () => {
      const { durable, env } = createDO()
      mockGetChannelForMember.mockResolvedValueOnce({ id: "chan-p", serverId: "server-1" })
      // The resolver applies the public/private split internally — a private
      // channel resolves to its audience (creator + added member + admin).
      mockResolveScopeMemberUserIds.mockResolvedValueOnce(["sender-1", "member-1"])

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "sender-1", authenticated: true })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "community:typing.start", channelId: "chan-p" }),
      )
      await flush()

      expect(mockResolveScopeMemberUserIds).toHaveBeenCalledWith(expect.anything(), {
        scope: "channel",
        scopeId: "chan-p",
      })
      expect(mockResolveChannelRecipientUserIds).toHaveBeenCalledWith(expect.anything(), "chan-p")
      expect(mockListMembers).not.toHaveBeenCalled()
      // Only the non-sender audience member gets a broadcast POST.
      expect((env.WS_DO as any).idFromName).toHaveBeenCalledWith("user:member-1")
      expect((env.WS_DO as any).idFromName).not.toHaveBeenCalledWith("user:sender-1")
      expect(mockStubFetch).toHaveBeenCalledTimes(1)
    })

    it("thread: typing fans out to PARTICIPANTS, not the channel audience", async () => {
      const { durable, env } = createDO()
      mockGetChannelForMember.mockResolvedValueOnce({ id: "t-1", serverId: "server-1" })
      mockGetChannelType.mockResolvedValueOnce("thread")
      mockListThreadParticipantUserIds.mockResolvedValueOnce(["sender-1", "part-1"])

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "sender-1", authenticated: true })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "community:typing.start", channelId: "t-1" }),
      )
      await flush()

      expect(mockListThreadParticipantUserIds).toHaveBeenCalledWith(expect.anything(), "t-1")
      // Thread typing must NOT fall back to the channel-audience resolver.
      expect(mockResolveScopeMemberUserIds).not.toHaveBeenCalled()
      expect((env.WS_DO as any).idFromName).toHaveBeenCalledWith("user:part-1")
      expect((env.WS_DO as any).idFromName).not.toHaveBeenCalledWith("user:sender-1")
      expect(mockStubFetch).toHaveBeenCalledTimes(1)
    })

    it("does not fan out when sender is not a participant of the target DM", async () => {
      const { durable, env } = createDO()
      // A DM is a type=dm channel now; a non-member sender can't see it, so
      // getChannelForMember returns null and fanOutTyping bails.
      mockGetChannelForMember.mockResolvedValueOnce(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "attacker", authenticated: true })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "community:typing.start", channelId: "dm-1" }),
      )
      await flush()

      expect(mockGetChannelForMember).toHaveBeenCalledWith(expect.anything(), "dm-1", "attacker")
      expect((env.WS_DO as any).get).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("fans out to the other participant when sender IS a DM participant", async () => {
      const { durable, env } = createDO()
      mockGetChannelForMember.mockResolvedValueOnce({ id: "dm-1", serverId: null })
      mockGetChannelType.mockResolvedValueOnce("dm")
      mockListChannelMemberUserIds.mockResolvedValueOnce(["alice", "bob"])

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "alice", authenticated: true })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "community:typing.start", channelId: "dm-1" }),
      )
      await flush()

      expect((env.WS_DO as any).idFromName).toHaveBeenCalledWith("user:bob")
      expect((env.WS_DO as any).idFromName).not.toHaveBeenCalledWith("user:alice")
      expect(mockStubFetch).toHaveBeenCalledTimes(1)
    })

    it("keeps membership retry separate while recipient retry re-runs the complete shared resolver", async () => {
      const { durable } = createDO()
      mockGetChannelForMember.mockResolvedValue({ id: "chan-1", serverId: "server-1" })
      mockResolveChannelRecipientUserIds
        .mockRejectedValueOnce(new Error("SQLITE_BUSY"))
        .mockResolvedValueOnce(["sender-1", "peer-1"])
      mockWithD1Retry.mockImplementation(async (fn, opts) => {
        if ((opts as { route?: string }).route !== "ws-do:agent-typing-recipients") return fn()
        try { return await fn() } catch { return fn() }
      })
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "sender-1", authenticated: true })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "community:typing.start", channelId: "chan-1" }),
      )
      await flushAsyncWork()

      expect(mockGetChannelForMember).toHaveBeenCalledTimes(1)
      expect(mockResolveChannelRecipientUserIds).toHaveBeenCalledTimes(2)
      expect(mockWithD1Retry.mock.calls.map((call) => (call[1] as { route?: string }).route)).toEqual([
        "ws-do:agent-typing-membership",
        "ws-do:agent-typing-recipients",
      ])
      const request = mockStubFetch.mock.calls[0]![0] as Request
      expect(JSON.parse(await request.text())).toEqual({
        type: "community:typing.start",
        channelId: "chan-1",
        userId: "sender-1",
      })
    })

    it("keeps typing delivery concurrency bounded by the class-owned batch size of forty", async () => {
      const { durable, env } = createDO()
      mockGetChannelForMember.mockResolvedValue({ id: "chan-1", serverId: "server-1" })
      mockResolveChannelRecipientUserIds.mockResolvedValue(
        Array.from({ length: 81 }, (_, index) => `recipient-${index}`),
      )
      let active = 0
      let maximum = 0
      const fetch = vi.fn(async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await Promise.resolve()
        active -= 1
        return new Response(JSON.stringify({ sent: 1 }))
      })
      ;(env.WS_DO.get as ReturnType<typeof vi.fn>).mockReturnValue({ fetch })
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "sender-1", authenticated: true })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "community:typing.start", channelId: "chan-1" }),
      )
      await flushAsyncWork()

      expect(fetch).toHaveBeenCalledTimes(81)
      expect(maximum).toBe(40)
    })

    it("contains no local reach classifier after delegating to shared", () => {
      const source = readFileSync("src/ws-durable/presence-typing.ts", "utf8")
      expect(source).not.toMatch(/\bchannelReach\b|\bisStoredChannelType\b|switch\s*\(\s*reach\s*\)/)
    })
  })
})
