import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMockWebSocket } from "./__mocks__/cf"
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
} from "./ws-durable/test-harness"

describe("WebSocketDurableObject", () => {
  beforeEach(() => resetHarness())
  afterEach(() => cleanupHarness())


  describe("community-machine — session.error overlay + optimistic clear", () => {
    beforeEach(() => {
      mockFindCredentialByHash.mockReset()
      mockGetMachineByIdForUser.mockReset()
      mockStubFetch.mockClear()
    })

    it("stashes lastRuntimeError overlay + fans out on session.error{runtime_not_available}", async () => {
      const { durable, store } = createDO()
      // Prime cached identity as if accept already ran.
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetMachineByIdForUser.mockResolvedValue({
        id: "cm_1",
        hostname: "host",
        availableRuntimes: [{ id: "codex" }],
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "session.error",
        code: "runtime_not_available",
        agentId: "a1",
        payload: { requested: "gemini", available: ["codex"] },
      })
      await durable.webSocketMessage(ws as any, frame)

      const overlay = store.get("community-machine-runtime-error") as
        | { requested: string; available: string[]; at: string }
        | undefined
      expect(overlay).toBeDefined()
      expect(overlay?.requested).toBe("gemini")
      expect(overlay?.available).toEqual(["codex"])

      // Fan-out went to the user DO with the overlay attached.
      expect(mockStubFetch).toHaveBeenCalled()
      const call = mockStubFetch.mock.calls.find((c: any[]) =>
        (c[0] as Request).url.endsWith("/broadcast")
      )
      const body = JSON.parse(await (call![0] as Request).clone().text()) as {
        type: string
        machine: { lastRuntimeError?: { requested: string; available: string[] } }
      }
      expect(body.type).toBe("community:machine.updated")
      expect(body.machine.lastRuntimeError).toMatchObject({
        requested: "gemini",
        available: ["codex"],
      })
    })

    it("forceClose closes attachments and clears identity+overlay", async () => {
      const { durable, ctx, store, getWebSockets } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      store.set("community-machine-handle", { userId: "u_1", machineId: "cm_1" })
      store.set("community-machine-runtime-error", {
        requested: "gemini",
        available: [],
        at: "2026-07-06T00:00:00.000Z",
      })
      mockGetMachineByIdForUser.mockResolvedValue({
        id: "cm_1",
        hostname: "host",
        availableRuntimes: [],
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })
      getWebSockets.mockReturnValue([ws])

      const req = new Request("http://internal/force-close", { method: "POST" })
      const res = await durable.fetch(req)
      expect(res.status).toBe(200)
      expect(ws.send).toHaveBeenCalled()
      expect(ws.close).toHaveBeenCalledWith(1008, "Revoked")

      // Cached identity + handle + overlay all cleared.
      expect(store.get("community-machine-identity")).toBeUndefined()
      expect(store.get("community-machine-handle")).toBeUndefined()
      expect(store.get("community-machine-runtime-error")).toBeUndefined()
    })
  })


  describe("community-machine — ready frame wire shape", () => {
    beforeEach(() => {
      mockUpsertMachineByMachineId.mockReset()
      mockStubFetch.mockClear()
    })

    // Regression guard: the daemon (WsControlChannel.reportReady) spreads
    // HostReady fields at the TOP LEVEL of the frame. If it ever regresses to
    // wrapping them under `ready:{...}`, the DO would silently drop every
    // ready and `last_seen_at` would never refresh. This test drives the exact
    // shape the daemon emits.
    it("accepts a flat daemon-shaped ready frame and calls upsertMachineByMachineId", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockUpsertMachineByMachineId.mockResolvedValue({
        machine: {
          id: "cm_1",
          hostname: "host",
          availableRuntimes: [{ id: "claude" }],
          status: "online",
          lastSeenAt: "2026-07-06T00:00:00.000Z",
        },
        priorLastSeenAt: "2026-07-05T00:00:00.000Z",
        priorAvailableRuntimes: [{ id: "claude" }],
        priorStatus: "offline",
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      // The wire frame the daemon actually sends — see WsControlChannel.reportReady.
      const frame = JSON.stringify({
        type: "ready",
        runtimeReport: [{ id: "claude", version: "1.0.0" }],
        runningAgents: [],
        hostname: "my-mac",
        platform: "darwin",
        arch: "arm64",
        osRelease: "23.0.0",
        daemonVersion: "0.1.0",
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockUpsertMachineByMachineId).toHaveBeenCalledTimes(1)
      const [, userId, machineId, meta] = mockUpsertMachineByMachineId.mock.calls[0]
      expect(userId).toBe("u_1")
      expect(machineId).toBe("cm_1")
      expect(meta).toMatchObject({
        hostname: "my-mac",
        platform: "darwin",
        arch: "arm64",
        osRelease: "23.0.0",
        daemonVersion: "0.1.0",
        availableRuntimes: [{ id: "claude", version: "1.0.0" }],
      })
    })

    it("silently drops a wrapped `{ready:{...}}` frame (legacy shape — regression guard)", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      // The (broken) wrapped shape — schema rejects → DO drops → no DB write.
      const frame = JSON.stringify({
        type: "ready",
        ready: {
          runtimeReport: [{ id: "claude" }],
          runningAgents: [],
          hostname: "my-mac",
        },
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockUpsertMachineByMachineId).not.toHaveBeenCalled()
    })
  })


  describe("community-machine — agent_activity frame", () => {
    beforeEach(() => {
      mockGetBotBinding.mockReset()
      mockUpdateProfile.mockReset().mockResolvedValue({})
      mockGetProfile.mockReset().mockResolvedValue(null)
      mockStubFetch.mockClear()
    })

    it("writes the translated statusEmoji/statusText via updateProfile and fans out community:status.update when the frame's machine owns the bot", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBinding.mockResolvedValue({ machineId: "cm_1", runtime: "codex" })
      mockGetCoMemberUserIds.mockResolvedValue(["viewer-1"])

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({ type: "agent_activity", agentId: "bot_1", state: "running" })
      await durable.webSocketMessage(ws as any, frame)

      // The (stubbed) `pickBotActivityPreset` returns a fixed pair for
      // "running" in this test — the assertion pins that exact pair.
      expect(mockUpdateProfile).toHaveBeenCalledWith(expect.anything(), "bot_1", {
        statusEmoji: "⚡",
        statusText: "Working on it",
      })
      const call = mockStubFetch.mock.calls.find((c: any[]) => (c[0] as Request).url.endsWith("/broadcast"))
      expect(call).toBeDefined()
      const body = JSON.parse(await (call![0] as Request).clone().text()) as {
        type: string
        userId: string
        statusEmoji: string
        statusText: string
      }
      expect(body).toEqual({
        type: "community:status.update",
        userId: "bot_1",
        statusEmoji: "⚡",
        statusText: "Working on it",
      })
    })

    it("drops a frame naming a bot bound to a different machine — no DB write, no fan-out", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBinding.mockResolvedValue({ machineId: "cm_OTHER", runtime: "codex" })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({ type: "agent_activity", agentId: "bot_1", state: "running" })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockUpdateProfile).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("drops a frame for an unbound (unknown) bot — no DB write, no fan-out", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBinding.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({ type: "agent_activity", agentId: "ghost_bot", state: "idle" })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockUpdateProfile).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("regression #3 — an owner-set custom status is NOT overwritten by a running frame (write-path guard); no DB write, no fan-out", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBinding.mockResolvedValue({ machineId: "cm_1", runtime: "codex" })
      // Prior status is a custom (non-preset) pair the owner set.
      mockGetProfile.mockResolvedValue({ statusEmoji: "🎨", statusText: "Painting" })

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "community-machine", machineId: "cm_1", userId: "u_1", authenticated: true })

      const frame = JSON.stringify({ type: "agent_activity", agentId: "bot_1", state: "running" })
      await durable.webSocketMessage(ws as any, frame)

      // Guard skips the write entirely — custom status survives, even though the
      // bot is working. This is what stops T6's heartbeat re-stomp every 5s.
      expect(mockUpdateProfile).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("regression #3b — a BRAND-NEW bot (profile row exists but status unset: emoji=null, text=\"\") still gets its status written", async () => {
      // `status_text` defaults to "" in the schema, so an unset status reads
      // back as (null, "") not (null, null). The custom-status guard must treat
      // that as "no status" (writable), NOT mistake "" for a custom status —
      // otherwise new bots never get a pill (the reported regression).
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBinding.mockResolvedValue({ machineId: "cm_1", runtime: "codex" })
      mockGetCoMemberUserIds.mockResolvedValue(["viewer-1"])
      mockGetProfile.mockResolvedValue({ statusEmoji: null, statusText: "" })

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "community-machine", machineId: "cm_1", userId: "u_1", authenticated: true })

      const frame = JSON.stringify({ type: "agent_activity", agentId: "bot_1", state: "running" })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockUpdateProfile).toHaveBeenCalledWith(expect.anything(), "bot_1", {
        statusEmoji: "⚡",
        statusText: "Working on it",
      })
    })

    it("regression #4 — a known idle preset still flips to running (guard didn't over-reach)", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBinding.mockResolvedValue({ machineId: "cm_1", runtime: "codex" })
      mockGetCoMemberUserIds.mockResolvedValue(["viewer-1"])
      // Prior is the idle PRESET (pipeline-owned) — must remain writable.
      mockGetProfile.mockResolvedValue({ statusEmoji: "💤", statusText: "Idle" })

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "community-machine", machineId: "cm_1", userId: "u_1", authenticated: true })

      const frame = JSON.stringify({ type: "agent_activity", agentId: "bot_1", state: "running" })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockUpdateProfile).toHaveBeenCalledWith(expect.anything(), "bot_1", {
        statusEmoji: "⚡",
        statusText: "Working on it",
      })
    })

    it("regression #4 — a known running preset still flips back to idle (guard didn't over-reach)", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBinding.mockResolvedValue({ machineId: "cm_1", runtime: "codex" })
      mockGetCoMemberUserIds.mockResolvedValue(["viewer-1"])
      // Prior is a running PRESET — an idle frame must be allowed to overwrite it.
      mockGetProfile.mockResolvedValue({ statusEmoji: "⚡", statusText: "Working on it" })

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "community-machine", machineId: "cm_1", userId: "u_1", authenticated: true })

      const frame = JSON.stringify({ type: "agent_activity", agentId: "bot_1", state: "idle" })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockUpdateProfile).toHaveBeenCalledWith(expect.anything(), "bot_1", {
        statusEmoji: "💤",
        statusText: "Idle",
      })
    })

    it("drops the frame with phase='binding_check' when getBotBinding throws — socket stays open, no write", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBinding.mockRejectedValue(new Error("D1 down"))

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({ type: "agent_activity", agentId: "bot_1", state: "running" })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockUpdateProfile).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
      // Socket didn't close — the DO doesn't touch ws.close() on any per-frame D1 error.
      expect(ws.close as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    })
  })


  describe("community-machine — agent_typing / agent_typing_stop frames", () => {
    beforeEach(() => {
      mockGetBotBindingWithOwner.mockReset()
      mockGetChannelForMember.mockReset()
      mockGetChannelType.mockReset()
      mockGetChannelType.mockResolvedValue("dm")
      mockListChannelMemberUserIds.mockReset()
      mockListChannelMemberUserIds.mockResolvedValue([])
      mockStubFetch.mockClear()
    })

    it("agent_typing: fans out community:typing.start to the DM peer when machine owns the bot and DM is valid", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBindingWithOwner.mockResolvedValue({
        machineId: "cm_1",
        runtime: "codex",
        ownerUserId: "u_1",
        name: "Bot",
        discriminator: "0007",
      })
      mockGetChannelForMember.mockResolvedValue({ id: "dm_1", serverId: null })
      mockGetChannelType.mockResolvedValue("dm")
      mockListChannelMemberUserIds.mockResolvedValue(["bot_1", "peer_1"])

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "agent_typing",
        agentId: "bot_1",
        channelId: "dm_1",
      })
      await durable.webSocketMessage(ws as any, frame)

      const call = mockStubFetch.mock.calls.find((c: any[]) => (c[0] as Request).url.endsWith("/broadcast"))
      expect(call).toBeDefined()
      const body = JSON.parse(await (call![0] as Request).clone().text()) as {
        type: string
        userId: string
        channelId: string
        name?: string
        discriminator?: string
      }
      // Bot path carries name/discriminator from the binding (getBotBindingWithOwner's
      // existing join) so the client renders the bot's name without a roster lookup.
      expect(body).toEqual({
        type: "community:typing.start",
        userId: "bot_1",
        channelId: "dm_1",
        name: "Bot",
        discriminator: "0007",
      })
    })

    it("agent_typing: drops a frame naming a bot bound to a different machine — no fan-out", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBindingWithOwner.mockResolvedValue({
        machineId: "cm_OTHER",
        runtime: "codex",
        ownerUserId: "u_1",
        name: "Bot",
        discriminator: "0007",
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "agent_typing",
        agentId: "bot_1",
        channelId: "dm_1",
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockGetChannelForMember).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("agent_typing: drops a frame for a bot that is not a DM participant — no fan-out", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBindingWithOwner.mockResolvedValue({
        machineId: "cm_1",
        runtime: "codex",
        ownerUserId: "u_1",
        name: "Bot",
        discriminator: "0007",
      })
      // Bot isn't a member of the channel → getChannelForMember returns null,
      // so fanOutTyping bails before resolving recipients.
      mockGetChannelForMember.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "agent_typing",
        agentId: "bot_1",
        channelId: "dm_1",
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("agent_typing_stop: fans out community:typing.stop to the DM peer, excludes sender", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBindingWithOwner.mockResolvedValue({
        machineId: "cm_1",
        runtime: "codex",
        ownerUserId: "u_1",
        name: "Bot",
        discriminator: "0007",
      })
      mockGetChannelForMember.mockResolvedValue({ id: "dm_1", serverId: null })
      mockGetChannelType.mockResolvedValue("dm")
      mockListChannelMemberUserIds.mockResolvedValue(["bot_1", "peer_1"])

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "agent_typing_stop",
        agentId: "bot_1",
        channelId: "dm_1",
      })
      await durable.webSocketMessage(ws as any, frame)

      const call = mockStubFetch.mock.calls.find((c: any[]) => (c[0] as Request).url.endsWith("/broadcast"))
      expect(call).toBeDefined()
      const body = JSON.parse(await (call![0] as Request).clone().text()) as {
        type: string
        userId: string
        channelId: string
      }
      expect(body).toEqual({
        type: "community:typing.stop",
        userId: "bot_1",
        channelId: "dm_1",
      })
      // Sender exclusion: only the peer (peer_1) is targeted — a single
      // /broadcast call, addressed via the peer's user DO.
      expect(mockStubFetch.mock.calls.filter((c: any[]) => (c[0] as Request).url.endsWith("/broadcast"))).toHaveLength(1)
    })
  })


  describe("community-machine — bot_audit_event frame", () => {
    beforeEach(() => {
      mockGetBotBindingWithOwner.mockReset()
      mockInsertBotActivityEventAndPrune.mockReset()
      mockStubFetch.mockClear()
    })

    it("inserts + prunes atomically and notifies the OWNER only when the machine owns the bot", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBindingWithOwner.mockResolvedValue({
        machineId: "cm_1",
        runtime: "codex",
        ownerUserId: "owner_1",
        name: "Bot",
        discriminator: "0007",
      })
      mockInsertBotActivityEventAndPrune.mockResolvedValue({
        id: "bae_abc",
        createdAt: "2025-01-01T00:00:00.000Z",
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "bot_audit_event",
        agentId: "bot_1",
        sessionId: "s_1",
        launchId: "l_1",
        event: { kind: "tool_call", payload: { name: "Read" } },
      })
      await durable.webSocketMessage(ws as any, frame)

      // Insert was called with server-derived payload (not trust-the-daemon).
      expect(mockInsertBotActivityEventAndPrune).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          botId: "bot_1",
          sessionId: "s_1",
          launchId: "l_1",
          kind: "tool_call",
          payload: JSON.stringify({ name: "Read" }),
        }),
      )
      // Owner is notified via notifyUserDO — request goes to `user:owner_1`
      // and the payload carries the full audit event including createdAt
      // stamped server-side.
      const call = mockStubFetch.mock.calls.find((c: any[]) => (c[0] as Request).url.endsWith("/broadcast"))
      expect(call).toBeDefined()
      const body = JSON.parse(await (call![0] as Request).clone().text()) as {
        type: string
        botId: string
        id: string
        kind: string
        payload: unknown
        createdAt: string
      }
      expect(body).toEqual({
        type: "community:bot.audit_event",
        botId: "bot_1",
        id: "bae_abc",
        kind: "tool_call",
        payload: { name: "Read" },
        sessionId: "s_1",
        launchId: "l_1",
        createdAt: "2025-01-01T00:00:00.000Z",
      })
    })

    it("drops a frame naming a bot bound to a different machine — no insert, no fan-out", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBindingWithOwner.mockResolvedValue({
        machineId: "cm_OTHER",
        runtime: "codex",
        ownerUserId: "owner_1",
        name: "Bot",
        discriminator: "0007",
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "bot_audit_event",
        agentId: "bot_1",
        event: { kind: "cli_invocation", payload: { subcommand: "send" } },
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockInsertBotActivityEventAndPrune).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("drops a frame for a soft-deleted/unknown bot — no insert, no fan-out", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBindingWithOwner.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "bot_audit_event",
        agentId: "ghost_bot",
        event: { kind: "thinking", payload: { text: "hmm", truncated: false, chars: 3 } },
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockInsertBotActivityEventAndPrune).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("does not fan out when the INSERT returns null (empty batch result)", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBindingWithOwner.mockResolvedValue({
        machineId: "cm_1",
        runtime: "codex",
        ownerUserId: "owner_1",
        name: "Bot",
        discriminator: "0007",
      })
      // Simulate the D1 batch returning no rows for the primary statement.
      mockInsertBotActivityEventAndPrune.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "bot_audit_event",
        agentId: "bot_1",
        event: { kind: "tool_call", payload: { name: "Read" } },
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockStubFetch).not.toHaveBeenCalled()
    })

    it("drops the frame with phase='write' when the insert throws — socket stays open, no fan-out", async () => {
      // This is the ws_frame_dropped_write category — the audit-loss SLO
      // signal. The DO must NOT close the socket, and no owner fan-out
      // should be emitted (the row was never persisted).
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetBotBindingWithOwner.mockResolvedValue({
        machineId: "cm_1",
        runtime: "codex",
        ownerUserId: "owner_1",
        name: "Bot",
        discriminator: "0007",
      })
      mockInsertBotActivityEventAndPrune.mockRejectedValue(new Error("D1 insert failed"))

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "bot_audit_event",
        agentId: "bot_1",
        event: { kind: "tool_call", payload: { name: "Read" } },
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockStubFetch).not.toHaveBeenCalled()
      expect(ws.close as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    })
  })


  describe("community-machine — reset/nap completion re-home (agent_session landing)", () => {
    beforeEach(() => {
      mockInsertBotAuditSessionReset.mockReset()
      mockInsertBotAuditNap.mockReset()
      mockInsertBotAuditModelChanged.mockReset()
      mockInsertBotAuditProviderChanged.mockReset()
      mockTouchBotRefreshContext.mockReset()
      mockGetBotBindingWithOwner.mockReset()
      mockStubFetch.mockClear()
      mockInsertBotAuditSessionReset.mockResolvedValue({ id: "bae_reset", createdAt: "2025-06-01T10:00:00.000Z" })
      mockInsertBotAuditNap.mockResolvedValue({ id: "bae_nap", createdAt: "2025-06-01T11:00:00.000Z" })
      mockInsertBotAuditModelChanged.mockResolvedValue({ id: "bae_model", createdAt: "2025-06-01T12:00:00.000Z" })
      mockInsertBotAuditProviderChanged.mockResolvedValue({ id: "bae_provider", createdAt: "2025-06-01T13:00:00.000Z" })
      mockTouchBotRefreshContext.mockResolvedValue(undefined)
      mockGetBotBindingWithOwner.mockResolvedValue({
        machineId: "cm_1",
        runtime: "codex",
        ownerUserId: "owner_1",
        name: "Bot",
        discriminator: "0007",
      })
    })

    function machineWs() {
      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "community-machine", machineId: "cm_1", userId: "u_1", authenticated: true })
      return ws
    }

    function seedIdentity(store: Map<string, unknown>) {
      store.set("community-machine-identity", { userId: "u_1", machineId: "cm_1", credentialHash: "0".repeat(64) })
    }

    // record-iff-sent>0: pending is only written when a live community-machine
    // socket accepts the forward. Seed one so /push and /push-*-switch tests
    // exercise the completion landing (offline → sent=0 → no pending).
    function onlineDaemon() {
      const { durable, store, getWebSockets } = createDO()
      seedIdentity(store)
      const daemon = machineWs()
      getWebSockets.mockReturnValue([daemon])
      return { durable, store, daemon }
    }

    // Helper: push a frame through /push (records pending attribution), matching
    // how the index worker forwards reset/nap frames to this DO.
    async function pushFrame(durable: any, body: unknown) {
      await durable.fetch(
        new (globalThis.Request as any)("http://internal/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    }

    async function pushSwitch(durable: any, kind: "provider" | "model", body: Record<string, unknown>) {
      await durable.fetch(
        new (globalThis.Request as any)(`http://internal/push-${kind}-switch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    }

    function auditBroadcast() {
      return mockStubFetch.mock.calls
        .map((c: any[]) => c[0] as Request)
        .find((r: Request) => r.url.endsWith("/broadcast"))
    }

    it("single reset: agent_session writes session_reset audit + stamps awake in lockstep + broadcasts", async () => {
      const { durable } = onlineDaemon()
      // Dispatch: an agent:reset frame is forwarded → records launchId→single.
      await pushFrame(durable, { type: "agent:reset", agentId: "bot_1", config: {}, launchId: "l_reset" })
      // Completion: the reborn agent's agent_session lands.
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_new", launchId: "l_reset" }),
      )

      // Audit written server-side with the trigger derived from the endpoint.
      expect(mockInsertBotAuditSessionReset).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ botId: "bot_1", launchId: "l_reset", trigger: "single" }),
      )
      expect(mockInsertBotAuditNap).not.toHaveBeenCalled()
      // LOCKSTEP invariant: touch uses the audit row's own createdAt, not another clock.
      expect(mockTouchBotRefreshContext).toHaveBeenCalledWith(expect.anything(), "bot_1", "2025-06-01T10:00:00.000Z")
      // Broadcast to the owner carries the session_reset event.
      const call = auditBroadcast()
      expect(call).toBeDefined()
      const body = JSON.parse(await (call!).clone().text()) as Record<string, unknown>
      expect(body).toEqual({
        type: "community:bot.audit_event",
        botId: "bot_1",
        id: "bae_reset",
        kind: "session_reset",
        payload: { trigger: "single" },
        sessionId: null,
        launchId: "l_reset",
        createdAt: "2025-06-01T10:00:00.000Z",
      })
    })

    it("two agent_session frames for the same launch write the reset audit ONCE (claim-first evict, no double record)", async () => {
      const { durable } = onlineDaemon()
      await pushFrame(durable, { type: "agent:reset", agentId: "bot_1", config: {}, launchId: "l_reset" })
      // Two agent_session frames arrive back-to-back for the SAME launch (e.g. a
      // runtime that announces its session twice). The pending trigger must be
      // consumed by the first → the second finds nothing → only ONE audit row.
      const frame = JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_new", launchId: "l_reset" })
      await durable.webSocketMessage(machineWs() as any, frame)
      await durable.webSocketMessage(machineWs() as any, frame)

      expect(mockInsertBotAuditSessionReset).toHaveBeenCalledTimes(1)
    })

    it("batch reset: each agent's agent_session writes session_reset with trigger reset_all", async () => {
      const { durable } = onlineDaemon()
      // Dispatch: ONE machine:reset_all frame carrying two launches.
      await pushFrame(durable, {
        type: "machine:reset_all",
        resets: [
          { agentId: "bot_1", config: {}, launchId: "l_a" },
          { agentId: "bot_2", config: {}, launchId: "l_b" },
        ],
      })
      // Both agents reborn — two agent_session frames.
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_a", launchId: "l_a" }),
      )
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_session", agentId: "bot_2", sessionId: "s_b", launchId: "l_b" }),
      )

      expect(mockInsertBotAuditSessionReset).toHaveBeenCalledTimes(2)
      expect(mockInsertBotAuditSessionReset).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({ botId: "bot_1", launchId: "l_a", trigger: "reset_all" }),
      )
      expect(mockInsertBotAuditSessionReset).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({ botId: "bot_2", launchId: "l_b", trigger: "reset_all" }),
      )
      expect(mockTouchBotRefreshContext).toHaveBeenCalledTimes(2)
    })

    it("nap: agent_session writes nap audit (trigger nap) + stamps awake in lockstep + broadcasts", async () => {
      const { durable } = onlineDaemon()
      await pushFrame(durable, { type: "agent:nap", agentId: "bot_1", config: {}, launchId: "l_nap", handoff: "note" })
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_new", launchId: "l_nap" }),
      )

      expect(mockInsertBotAuditNap).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ botId: "bot_1", launchId: "l_nap" }),
      )
      expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
      expect(mockTouchBotRefreshContext).toHaveBeenCalledWith(expect.anything(), "bot_1", "2025-06-01T11:00:00.000Z")
      const body = JSON.parse(await (auditBroadcast()!).clone().text()) as Record<string, unknown>
      expect(body).toMatchObject({ kind: "nap", payload: { trigger: "nap" }, launchId: "l_nap" })
    })

    it("fire-once: a replayed agent_session for the same launch writes nothing the second time", async () => {
      const { durable } = onlineDaemon()
      await pushFrame(durable, { type: "agent:reset", agentId: "bot_1", config: {}, launchId: "l_reset" })
      const frame = JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_new", launchId: "l_reset" })
      await durable.webSocketMessage(machineWs() as any, frame)
      await durable.webSocketMessage(machineWs() as any, frame) // replay

      // Exactly one write despite two agent_session frames — the pending entry
      // was consumed (deleted) on the first.
      expect(mockInsertBotAuditSessionReset).toHaveBeenCalledTimes(1)
      expect(mockTouchBotRefreshContext).toHaveBeenCalledTimes(1)
    })

    it("no pending launch: an ordinary agent_session (never a reset/nap) writes nothing", async () => {
      const { durable, store } = createDO()
      seedIdentity(store)
      // No /push recorded this launch — a plain wake session.
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_new", launchId: "l_plain" }),
      )
      expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
      expect(mockInsertBotAuditNap).not.toHaveBeenCalled()
      expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
    })

    it("offline push (sent===0): records no pending — later agent_session writes nothing", async () => {
      const { durable, store, getWebSockets } = createDO()
      seedIdentity(store)
      getWebSockets.mockReturnValue([])
      await pushFrame(durable, { type: "agent:reset", agentId: "bot_1", config: {}, launchId: "l_offline" })
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_new", launchId: "l_offline" }),
      )
      expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
      expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
    })

    // Cecilia #1270: landing must dispatch by pending.kind — provider stamps
    // awake; model does not; payloads stay in their namespaces.
    it("provider_switch: agent_session writes provider_changed {from,to} + stamps awake (not model_changed)", async () => {
      const { durable } = onlineDaemon()
      await pushSwitch(durable, "provider", {
        agentId: "bot_1",
        config: { runtime: "codex" },
        launchId: "l_prov",
        from: "claude",
        to: "codex",
      })
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_new", launchId: "l_prov" }),
      )

      expect(mockInsertBotAuditProviderChanged).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ botId: "bot_1", launchId: "l_prov", from: "claude", to: "codex" }),
      )
      expect(mockInsertBotAuditModelChanged).not.toHaveBeenCalled()
      expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
      expect(mockTouchBotRefreshContext).toHaveBeenCalledWith(expect.anything(), "bot_1", "2025-06-01T13:00:00.000Z")
      const body = JSON.parse(await (auditBroadcast()!).clone().text()) as Record<string, unknown>
      expect(body).toMatchObject({
        kind: "provider_changed",
        payload: { from: "claude", to: "codex" },
        launchId: "l_prov",
      })
    })

    // Cecilia #1279: provider PATCH clears model as a binding side-effect, but
    // landing must emit exactly one provider_changed — never a sibling model_changed.
    it("provider_switch with cleared model in config → exactly one provider_changed, zero model_changed", async () => {
      const { durable } = onlineDaemon()
      await pushSwitch(durable, "provider", {
        agentId: "bot_1",
        // Mirrors route after provider switch: runtime flipped + model null→default.
        config: { runtime: "codex", model: { kind: "default" } },
        launchId: "l_prov_clear_model",
        from: "claude",
        to: "codex",
      })
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({
          type: "agent_session",
          agentId: "bot_1",
          sessionId: "s_new",
          launchId: "l_prov_clear_model",
        }),
      )

      expect(mockInsertBotAuditProviderChanged).toHaveBeenCalledTimes(1)
      expect(mockInsertBotAuditProviderChanged).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          botId: "bot_1",
          launchId: "l_prov_clear_model",
          from: "claude",
          to: "codex",
        }),
      )
      expect(mockInsertBotAuditModelChanged).not.toHaveBeenCalled()
      expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
      const broadcasts = mockStubFetch.mock.calls
        .map((c: any[]) => c[0] as Request)
        .filter((r: Request) => r.url.endsWith("/broadcast"))
      expect(broadcasts).toHaveLength(1)
      const body = JSON.parse(await broadcasts[0]!.clone().text()) as Record<string, unknown>
      expect(body.kind).toBe("provider_changed")
      expect(body.kind).not.toBe("model_changed")
    })

    it("model_switch: agent_session writes model_changed {from,to} and does NOT stamp awake", async () => {
      const { durable } = onlineDaemon()
      await pushSwitch(durable, "model", {
        agentId: "bot_1",
        config: { model: { kind: "named", name: "opus" } },
        launchId: "l_model",
        from: null,
        to: "opus",
      })
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_new", launchId: "l_model" }),
      )

      expect(mockInsertBotAuditModelChanged).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ botId: "bot_1", launchId: "l_model", from: null, to: "opus" }),
      )
      expect(mockInsertBotAuditProviderChanged).not.toHaveBeenCalled()
      expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
      const body = JSON.parse(await (auditBroadcast()!).clone().text()) as Record<string, unknown>
      expect(body).toMatchObject({
        kind: "model_changed",
        payload: { from: null, to: "opus" },
        launchId: "l_model",
      })
    })

    it("cold-start fail branch B (agent_wake_ack error): evicts pending, no audit/awake, and a later replayed agent_session stays silent", async () => {
      const { durable } = onlineDaemon()
      await pushFrame(durable, { type: "agent:reset", agentId: "bot_1", config: {}, launchId: "l_reset" })
      // Enroll fail / spawn threw → wake_ack error for this launch.
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_wake_ack", agentId: "bot_1", launchId: "l_reset", status: "error", error: { code: "spawn_threw", message: "boom" } }),
      )
      // If (impossibly) an agent_session arrives later, the entry is already gone
      // → nothing written. This is the red-line-② positive proof.
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_new", launchId: "l_reset" }),
      )
      expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
      expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
    })

    it("cold-start fail branch A (session.error runtime_not_available): evicts pending, no audit/awake", async () => {
      const { durable } = onlineDaemon()
      await pushFrame(durable, { type: "agent:reset", agentId: "bot_1", config: {}, launchId: "l_reset" })
      // Runtime not installed → session.error carrying the launchId (Melisa's source half).
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "session.error", code: "runtime_not_available", agentId: "bot_1", launchId: "l_reset", payload: { requested: "codex", available: [] } }),
      )
      await durable.webSocketMessage(
        machineWs() as any,
        JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_new", launchId: "l_reset" }),
      )
      expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
      expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
    })
  })


  describe("community-machine — ready frame reconciles bot activity", () => {
    beforeEach(() => {
      mockUpsertMachineByMachineId.mockReset()
      mockReconcileBotActivityFromRunningAgents.mockReset().mockResolvedValue([])
      mockStubFetch.mockClear()
    })

    it("a ready frame whose runningAgents disagrees with persisted state fans out community:status.update for each cleared bot", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockUpsertMachineByMachineId.mockResolvedValue({
        machine: {
          id: "cm_1",
          hostname: "host",
          availableRuntimes: [],
          status: "online",
          lastSeenAt: "2026-07-13T00:00:00.000Z",
        },
        priorLastSeenAt: "2026-07-12T00:00:00.000Z",
        priorAvailableRuntimes: [],
        priorStatus: "online",
      })
      mockReconcileBotActivityFromRunningAgents.mockResolvedValue([
        { botUserId: "bot_1", statusEmoji: "💤", statusText: "Idle" },
        { botUserId: "bot_2", statusEmoji: "💤", statusText: "Idle" },
      ])
      mockGetCoMemberUserIds.mockResolvedValue(["viewer-1"])

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "ready",
        runtimeReport: [],
        runningAgents: [],
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockReconcileBotActivityFromRunningAgents).toHaveBeenCalledWith(expect.anything(), "cm_1", [])
      const activityCalls = mockStubFetch.mock.calls.filter((c: any[]) => (c[0] as Request).url.endsWith("/broadcast"))
      const bodies = await Promise.all(activityCalls.map((c: any[]) => (c[0] as Request).clone().text()))
      const parsed = bodies.map((b) => JSON.parse(b)).filter((b) => b.type === "community:status.update")
      expect(parsed).toEqual(
        expect.arrayContaining([
          { type: "community:status.update", userId: "bot_1", statusEmoji: "💤", statusText: "Idle" },
          { type: "community:status.update", userId: "bot_2", statusEmoji: "💤", statusText: "Idle" },
        ])
      )
    })

    it("emits no status.update fan-out when reconciliation finds no changes", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockUpsertMachineByMachineId.mockResolvedValue({
        machine: {
          id: "cm_1",
          hostname: "host",
          availableRuntimes: [],
          status: "online",
          lastSeenAt: "2026-07-13T00:00:00.000Z",
        },
        priorLastSeenAt: "2026-07-12T00:00:00.000Z",
        priorAvailableRuntimes: [],
        priorStatus: "online",
      })
      mockReconcileBotActivityFromRunningAgents.mockResolvedValue([])

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({ type: "ready", runtimeReport: [], runningAgents: [] })
      await durable.webSocketMessage(ws as any, frame)

      const activityCalls = mockStubFetch.mock.calls.filter((c: any[]) => (c[0] as Request).url.endsWith("/broadcast"))
      const bodies = await Promise.all(activityCalls.map((c: any[]) => (c[0] as Request).clone().text()))
      const parsed = bodies.map((b) => JSON.parse(b)).filter((b) => b.type === "community:status.update")
      expect(parsed).toEqual([])
    })
  })


  describe("community-machine — webSocketClose presence lifecycle", () => {
    // These tests cover the "graceful daemon quit → immediate offline" fix.
    // See plans/community-machine-presence-fix.md § Server transitions.
    it("flips status=offline via credential-scoped markMachineOffline and broadcasts on real transition", async () => {
      const { durable, store, ctx } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      // Arm a placeholder alarm so we can check deleteAlarm ran.
      await ctx.storage.setAlarm(Date.now() + 90_000)
      mockMarkMachineOffline.mockResolvedValueOnce({
        id: "cm_1",
        userId: "u_1",
        status: "offline",
        lastSeenAt: "2026-07-06T00:00:00.000Z",
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      await durable.webSocketClose(ws as any)

      expect(mockMarkMachineOffline).toHaveBeenCalledTimes(1)
      const [, args] = mockMarkMachineOffline.mock.calls[0]!
      expect(args).toMatchObject({
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      // Broadcast fired via notifyUserDO → user DO's /broadcast endpoint.
      expect(mockStubFetch).toHaveBeenCalled()
      // Alarm was cleaned up and storage keys deleted.
      expect(ctx.storage.deleteAlarm).toHaveBeenCalled()
      expect(store.has("community-machine-identity")).toBe(false)
      expect(store.has("community-machine-handle")).toBe(false)
    })

    it("null return (credential revoked or already offline) does NOT broadcast and leaves the alarm armed", async () => {
      const { durable, store, ctx } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "revoked",
      })
      mockMarkMachineOffline.mockResolvedValueOnce(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      mockStubFetch.mockClear()
      await durable.webSocketClose(ws as any)

      expect(mockMarkMachineOffline).toHaveBeenCalledTimes(1)
      // No broadcast fired — the guarded UPDATE returned zero rows.
      expect(mockStubFetch).not.toHaveBeenCalled()
      // Alarm armed as the safety-net fallback (setAlarm was called; not deleted).
      expect(ctx.storage.setAlarm).toHaveBeenCalled()
      expect(ctx.storage.deleteAlarm).not.toHaveBeenCalled()
      // Storage keys retained — a different DO instance may own the row now.
      expect(store.has("community-machine-identity")).toBe(true)
    })

    it("missing IDENTITY_KEY (never fully accepted) is a clean no-op — no markMachineOffline, no alarm", async () => {
      const { durable, store, ctx } = createDO()
      // No identity in storage.
      expect(store.has("community-machine-identity")).toBe(false)

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

        // Clear any setAlarm calls made during createDO setup.
        ; (ctx.storage.setAlarm as any).mockClear?.()

      await durable.webSocketClose(ws as any)

      expect(mockMarkMachineOffline).not.toHaveBeenCalled()
      // No alarm armed — with no identity there's nothing recoverable to do.
      // HANDLE_KEY is written alongside IDENTITY_KEY, so if identity is gone
      // the alarm has no state to act on either.
      expect(ctx.storage.setAlarm).not.toHaveBeenCalled()
    })
  })


  describe("community-machine — alarm presence + backfill", () => {
    it("live-WS + status=offline row: markMachineOnlineIfOffline flips it back online and broadcasts (post-deploy backfill)", async () => {
      const { durable, store, getWebSockets, ctx } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "abc",
      })

      // Attach a live authenticated community-machine WS.
      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })
      getWebSockets.mockReturnValue([ws])

      mockTouchMachineHeartbeat.mockResolvedValueOnce({
        lastSeenAt: "now",
        priorLastSeenAt: "earlier",
      })
      mockMarkMachineOnlineIfOffline.mockResolvedValueOnce({
        id: "cm_1",
        userId: "u_1",
        status: "online",
        lastSeenAt: "now",
      })

      mockStubFetch.mockClear()
      await durable.alarm()

      expect(mockTouchMachineHeartbeat).toHaveBeenCalledTimes(1)
      expect(mockMarkMachineOnlineIfOffline).toHaveBeenCalledTimes(1)
      // Broadcast fired for the offline→online transition.
      expect(mockStubFetch).toHaveBeenCalled()
      // Alarm rescheduled for the next heartbeat tick.
      expect(ctx.storage.setAlarm).toHaveBeenCalled()
    })

    it("live-WS + status=online row (steady state): no broadcast fires (double-broadcast regression guard)", async () => {
      const { durable, store, getWebSockets, ctx } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "abc",
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })
      getWebSockets.mockReturnValue([ws])

      mockTouchMachineHeartbeat.mockResolvedValueOnce({
        lastSeenAt: "now",
        priorLastSeenAt: "earlier",
      })
      // Guarded UPDATE returns zero rows — row is already online.
      mockMarkMachineOnlineIfOffline.mockResolvedValueOnce(null)

      mockStubFetch.mockClear()
      await durable.alarm()

      expect(mockTouchMachineHeartbeat).toHaveBeenCalledTimes(1)
      // No broadcast — the guarded UPDATE returned zero rows.
      expect(mockStubFetch).not.toHaveBeenCalled()
      // Alarm rescheduled.
      expect(ctx.storage.setAlarm).toHaveBeenCalled()
    })

    it("no-live-WS + stale row: markMachineOffline flips + broadcasts + cleans HANDLE_KEY / IDENTITY_KEY", async () => {
      const { durable, store, getWebSockets, ctx } = createDO()
      // No live WS.
      getWebSockets.mockReturnValue([])
      store.set("community-machine-handle", { userId: "u_1", machineId: "cm_1" })
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "abc",
      })
      // Stale row — lastSeenAt is more than 120s (mocked threshold) ago.
      mockGetMachineByIdForUser.mockResolvedValueOnce({
        id: "cm_1",
        userId: "u_1",
        status: "online",
        lastSeenAt: new Date(Date.now() - 200_000).toISOString(),
        availableRuntimes: [],
      })
      mockMarkMachineOffline.mockResolvedValueOnce({
        id: "cm_1",
        userId: "u_1",
        status: "offline",
        lastSeenAt: "now",
      })

      mockStubFetch.mockClear()
      await durable.alarm()

      expect(mockMarkMachineOffline).toHaveBeenCalledTimes(1)
      expect(mockStubFetch).toHaveBeenCalled()
      expect(store.has("community-machine-handle")).toBe(false)
      expect(store.has("community-machine-identity")).toBe(false)
      // No further alarm reschedule after the terminal offline flip.
      // (setAlarm may have been called on the earlier setup path; we assert
      // deleteAlarm was NOT called since alarm() doesn't need to explicitly
      // delete — it just doesn't reschedule.)
      expect(ctx.storage.deleteAlarm).not.toHaveBeenCalled()
    })

    it("no-live-WS + stale row + no identity (mid-lifecycle wipe): still broadcasts offline using stored handle so UI sees the transition", async () => {
      const { durable, store, getWebSockets, ctx } = createDO()
      getWebSockets.mockReturnValue([])
      // HANDLE_KEY is present (written at accept) but IDENTITY_KEY was
      // wiped mid-lifecycle. The stale-flip branch can't run the
      // credential-scoped UPDATE, but must still broadcast so the UI
      // reflects the transition.
      store.set("community-machine-handle", { userId: "u_1", machineId: "cm_1" })
      expect(store.has("community-machine-identity")).toBe(false)

      mockGetMachineByIdForUser.mockResolvedValueOnce({
        id: "cm_1",
        userId: "u_1",
        status: "online",
        lastSeenAt: new Date(Date.now() - 200_000).toISOString(),
        availableRuntimes: [],
      })

      mockStubFetch.mockClear()
      await durable.alarm()

      // DB flip skipped (no identity to scope the credential guard).
      expect(mockMarkMachineOffline).not.toHaveBeenCalled()
      // But the UI broadcast MUST still fire — otherwise the machine
      // chip stays green until reload.
      expect(mockStubFetch).toHaveBeenCalled()
      // Storage keys dropped — this DO's presence lifecycle is done.
      expect(store.has("community-machine-handle")).toBe(false)
      expect(ctx.storage.deleteAlarm).not.toHaveBeenCalled()
    })

    it("no-live-WS + fresh row: reschedules alarm to exact stale moment, no broadcast, no DB flip", async () => {
      const { durable, store, getWebSockets, ctx } = createDO()
      getWebSockets.mockReturnValue([])
      store.set("community-machine-handle", { userId: "u_1", machineId: "cm_1" })
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "abc",
      })
      // Fresh row — lastSeenAt is 10s ago.
      mockGetMachineByIdForUser.mockResolvedValueOnce({
        id: "cm_1",
        userId: "u_1",
        status: "online",
        lastSeenAt: new Date(Date.now() - 10_000).toISOString(),
        availableRuntimes: [],
      })

      mockStubFetch.mockClear()
      await durable.alarm()

      expect(mockMarkMachineOffline).not.toHaveBeenCalled()
      expect(mockStubFetch).not.toHaveBeenCalled()
      // Storage keys retained; alarm rescheduled precisely to the stale moment.
      expect(store.has("community-machine-handle")).toBe(true)
      expect(store.has("community-machine-identity")).toBe(true)
      expect(ctx.storage.setAlarm).toHaveBeenCalled()
    })
  })
})
