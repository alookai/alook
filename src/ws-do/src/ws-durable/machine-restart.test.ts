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
          .find((r: Request) => r.url.endsWith("/community-broadcast"))
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
          .filter((r: Request) => r.url.endsWith("/community-broadcast"))
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

  describe("C2c characterization — machine restart", () => {
      beforeEach(() => {
        mockGetBotBindingWithOwner.mockReset()
        mockInsertBotAuditSessionReset.mockReset()
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

      it("consumes the pending claim before dropping a machine-binding mismatch", async () => {
        const { durable, store, ws } = setup()
        store.set("reset-pending:l_mismatch", { kind: "session_reset", trigger: "single" })
        mockGetBotBindingWithOwner.mockResolvedValue({
          machineId: "cm_other",
          runtime: "codex",
          ownerUserId: "owner_1",
          name: "Bot",
          discriminator: "0007",
        })

        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_1", launchId: "l_mismatch" }),
        )

        expect(store.has("reset-pending:l_mismatch")).toBe(false)
        expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
      })

      it("keeps claims consumed after binding and write failures", async () => {
        const first = setup()
        first.store.set("reset-pending:l_binding", { kind: "session_reset", trigger: "single" })
        mockGetBotBindingWithOwner.mockRejectedValueOnce(new Error("binding failed"))

        await first.durable.webSocketMessage(
          first.ws as any,
          JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_1", launchId: "l_binding" }),
        )

        const second = setup()
        second.store.set("reset-pending:l_write", { kind: "session_reset", trigger: "single" })
        mockGetBotBindingWithOwner.mockResolvedValueOnce({
          machineId: "cm_1",
          runtime: "codex",
          ownerUserId: "owner_1",
          name: "Bot",
          discriminator: "0007",
        })
        mockInsertBotAuditSessionReset.mockRejectedValueOnce(new Error("write failed"))

        await second.durable.webSocketMessage(
          second.ws as any,
          JSON.stringify({ type: "agent_session", agentId: "bot_1", sessionId: "s_2", launchId: "l_write" }),
        )

        expect(first.store.has("reset-pending:l_binding")).toBe(false)
        expect(second.store.has("reset-pending:l_write")).toBe(false)
      })

      it("records only valid launch ids from malformed, unknown, and mixed reset frames in order", async () => {
        const { durable, getWebSockets, storage } = setup()
        const daemon = createMockWebSocket()
        daemon.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        getWebSockets.mockReturnValue([daemon])
        const push = (body: string) => durable.fetch(
          new (globalThis.Request as any)("http://internal/push", { method: "POST", body }),
        )

        await push("{")
        await push(JSON.stringify({ type: "unknown", launchId: "l_unknown" }))
        storage.put.mockClear()
        await push(JSON.stringify({
          type: "machine:reset_all",
          resets: [
            { agentId: "bot_1", launchId: "l_1" },
            null,
            { agentId: "bot_2", launchId: "" },
            { agentId: "bot_3", launchId: "l_2" },
            { agentId: "bot_4", launchId: 4 },
          ],
        }))

        expect(storage.put.mock.calls).toEqual([
          ["reset-pending:l_1", { kind: "session_reset", trigger: "reset_all" }],
          ["reset-pending:l_2", { kind: "session_reset", trigger: "reset_all" }],
        ])
      })
    })
})
