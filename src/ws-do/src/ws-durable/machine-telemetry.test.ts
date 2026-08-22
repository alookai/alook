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
  mockLogDebug,
  mockLogWarn,
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
        const call = mockStubFetch.mock.calls.find((c: any[]) => (c[0] as Request).url.endsWith("/community-broadcast"))
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

        const call = mockStubFetch.mock.calls.find((c: any[]) => (c[0] as Request).url.endsWith("/community-broadcast"))
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

        const call = mockStubFetch.mock.calls.find((c: any[]) => (c[0] as Request).url.endsWith("/community-broadcast"))
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
        expect(mockStubFetch.mock.calls.filter((c: any[]) => (c[0] as Request).url.endsWith("/community-broadcast"))).toHaveLength(1)
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
        const call = mockStubFetch.mock.calls.find((c: any[]) => (c[0] as Request).url.endsWith("/community-broadcast"))
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

  describe("C2c characterization — machine telemetry", () => {
      beforeEach(() => {
        mockGetBotBinding.mockReset()
        mockGetBotBindingWithOwner.mockReset()
        mockGetChannelForMember.mockReset()
        mockGetProfile.mockReset().mockResolvedValue(null)
        mockUpdateProfile.mockReset().mockResolvedValue({})
        mockInsertBotAuditNap.mockReset()
        mockInsertBotActivityEventAndPrune.mockReset()
        mockTouchBotRefreshContext.mockReset().mockResolvedValue(undefined)
        mockStubFetch.mockClear()
      })

      function setup() {
        const result = createDO()
        result.store.set("community-machine-identity", {
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
        return { ...result, ws }
      }

      const binding = {
        machineId: "cm_1",
        runtime: "codex",
        ownerUserId: "owner_1",
        name: "Bot",
        discriminator: "0007",
      }

      it("does not rewrite or fan out an unchanged running activity preset", async () => {
        const { durable, ws } = setup()
        mockGetBotBinding.mockResolvedValue(binding)
        mockGetProfile.mockResolvedValue({ statusEmoji: "⚡", statusText: "Working on it" })

        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({ type: "agent_activity", agentId: "bot_1", state: "running" }),
        )

        expect(mockUpdateProfile).not.toHaveBeenCalled()
        expect(mockStubFetch).not.toHaveBeenCalled()
      })

      it("classifies activity write failures as plain write drops", async () => {
        const { durable, ws } = setup()
        mockGetBotBinding.mockResolvedValue(binding)
        mockGetProfile.mockRejectedValue(new Error("D1 unavailable"))

        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({ type: "agent_activity", agentId: "bot_1", state: "running" }),
        )

        expect(mockLogWarn).toHaveBeenCalledWith(
          "ws_frame_dropped",
          expect.objectContaining({
            category: "ws_frame_dropped",
            frame_type: "agent_activity",
            phase: "write",
          }),
        )
      })

      it("classifies typing binding failures before the write phase", async () => {
        const { durable, ws } = setup()
        mockGetBotBindingWithOwner.mockRejectedValue(new Error("D1 unavailable"))

        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({ type: "agent_typing", agentId: "bot_1", channelId: "dm_1" }),
        )

        expect(mockLogWarn).toHaveBeenCalledWith(
          "ws_frame_dropped",
          expect.objectContaining({
            category: "ws_frame_dropped",
            frame_type: "agent_typing",
            phase: "binding_check",
          }),
        )
      })

      it("classifies typing fan-out failures as plain write drops", async () => {
        const { durable, ws } = setup()
        mockGetBotBindingWithOwner.mockResolvedValue(binding)
        mockGetChannelForMember.mockRejectedValue(new Error("D1 unavailable"))

        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({ type: "agent_typing", agentId: "bot_1", channelId: "dm_1" }),
        )

        expect(mockLogWarn).toHaveBeenCalledWith(
          "ws_frame_dropped",
          expect.objectContaining({
            category: "ws_frame_dropped",
            frame_type: "agent_typing",
            phase: "write",
          }),
        )
      })

      it("keeps audit binding failures outside the audit-write SLO category", async () => {
        const { durable, ws } = setup()
        mockGetBotBindingWithOwner.mockRejectedValue(new Error("D1 unavailable"))

        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({
            type: "bot_audit_event",
            agentId: "bot_1",
            event: { kind: "tool_call", payload: { name: "Read" } },
          }),
        )

        expect(mockLogWarn).toHaveBeenCalledWith(
          "ws_frame_dropped",
          expect.objectContaining({
            category: "ws_frame_dropped",
            frame_type: "bot_audit_event",
            phase: "binding_check",
          }),
        )
      })

      it("skips awake and owner notification when an agent-session audit insert returns null", async () => {
        const { durable, store, ws } = setup()
        store.set("reset-pending:l_nap", { kind: "nap" })
        mockGetBotBindingWithOwner.mockResolvedValue(binding)
        mockInsertBotAuditNap.mockResolvedValue(null)

        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_1", launchId: "l_nap" }),
        )

        expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
        expect(mockStubFetch).not.toHaveBeenCalled()
      })
    })
})
