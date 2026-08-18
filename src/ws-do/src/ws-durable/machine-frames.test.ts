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
          (c[0] as Request).url.endsWith("/community-broadcast")
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
          capabilities: ["control-heartbeat-v1"],
          runningAgents: [],
          hostname: "my-mac",
          platform: "darwin",
          arch: "arm64",
          osRelease: "23.0.0",
          daemonVersion: "0.1.0",
        })
        await durable.webSocketMessage(ws as any, frame)

        expect(mockUpsertMachineByMachineId).toHaveBeenCalledTimes(1)
        const [, userId, machineId, meta, credentialHash] = mockUpsertMachineByMachineId.mock.calls[0]
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
        expect(credentialHash).toBe("0".repeat(64))
      })

      it.each([
        ["legacy ready", undefined, false],
        ["heartbeat-capable ready", ["control-heartbeat-v1"], true],
      ] as const)("capability-gates the app heartbeat lease for %s", async (_name, capabilities, expected) => {
        vi.spyOn(Date, "now").mockReturnValue(9_000_000)
        const { durable, store } = createDO()
        store.set("community-machine-identity", {
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "hash",
        })
        const ws = createMockWebSocket()
        ws.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        if (expected) {
          mockUpsertMachineByMachineId.mockResolvedValueOnce({
            machine: {
              id: "cm_1",
              hostname: "host",
              availableRuntimes: [],
              status: "online",
              lastSeenAt: "now",
            },
            priorLastSeenAt: "before",
            priorAvailableRuntimes: [],
            priorDaemonVersion: "0.1.0",
            priorStatus: "online",
          })
        }

        await durable.webSocketMessage(ws as any, JSON.stringify({
          type: "ready",
          runtimeReport: [],
          runningAgents: [],
          ...(capabilities ? { capabilities } : {}),
        }))

        expect(ws._attachment).toMatchObject({ controlHeartbeat: expected })
        if (expected) {
          expect((ws._attachment as any).lastHeartbeatAckAt).toBe(9_000_000)
          expect(ws.close).not.toHaveBeenCalled()
        } else {
          expect((ws._attachment as any).lastHeartbeatAckAt).toBeUndefined()
          expect(ws.close).toHaveBeenCalledWith(1008, "Daemon upgrade required")
          expect(mockUpsertMachineByMachineId).not.toHaveBeenCalled()
        }
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

  describe("community-machine — control-plane receipt scope", () => {
      it("consumes but does not accept a diagnostics receipt from a mismatched machine socket", async () => {
        const { durable, store } = createDO()
        store.set("community-machine-identity", {
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "hash",
        })
        const ws = createMockWebSocket()
        ws.serializeAttachment({
          type: "community-machine",
          machineId: "cm_other",
          userId: "u_1",
          authenticated: true,
        })
        mockLogDebug.mockClear()

        await durable.webSocketMessage(ws as any, JSON.stringify({
          type: "diagnostics_ack",
          reportId: "dbr_0123456789abcdef",
        }))

        expect(mockLogDebug).not.toHaveBeenCalledWith(
          "diagnostics command receipted",
          expect.anything(),
        )
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
          capabilities: ["control-heartbeat-v1"],
          runningAgents: [],
        })
        await durable.webSocketMessage(ws as any, frame)

        expect(mockReconcileBotActivityFromRunningAgents).toHaveBeenCalledWith(expect.anything(), "cm_1", [])
        const activityCalls = mockStubFetch.mock.calls.filter((c: any[]) => (c[0] as Request).url.endsWith("/community-broadcast"))
        const bodies = await Promise.all(activityCalls.map((c: any[]) => (c[0] as Request).clone().text()))
        const parsed = bodies.map((b) => JSON.parse(b)).filter((b) => b.type === "community:status.update")
        expect(parsed).toEqual(
          expect.arrayContaining([
            { contractVersion: 1, type: "community:status.update", userId: "bot_1", statusEmoji: "💤", statusText: "Idle" },
            { contractVersion: 1, type: "community:status.update", userId: "bot_2", statusEmoji: "💤", statusText: "Idle" },
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

        const frame = JSON.stringify({
          type: "ready",
          runtimeReport: [],
          capabilities: ["control-heartbeat-v1"],
          runningAgents: [],
        })
        await durable.webSocketMessage(ws as any, frame)

        const activityCalls = mockStubFetch.mock.calls.filter((c: any[]) => (c[0] as Request).url.endsWith("/community-broadcast"))
        const bodies = await Promise.all(activityCalls.map((c: any[]) => (c[0] as Request).clone().text()))
        const parsed = bodies.map((b) => JSON.parse(b)).filter((b) => b.type === "community:status.update")
        expect(parsed).toEqual([])
      })
    })

  describe("C2c characterization — machine frames", () => {
      beforeEach(() => {
        mockGetMachineByIdForUser.mockReset().mockResolvedValue(null)
        mockUpsertMachineByMachineId.mockReset()
        mockReconcileBotActivityFromRunningAgents.mockReset().mockResolvedValue([])
        mockStubFetch.mockClear()
      })

      function machineWs() {
        const ws = createMockWebSocket()
        ws.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        return ws
      }

      function seedIdentity(store: Map<string, unknown>) {
        store.set("community-machine-identity", {
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "0".repeat(64),
        })
      }

      it("observes ok command acknowledgements without persistence", async () => {
        const { durable, store, storage } = createDO()
        seedIdentity(store)

        await durable.webSocketMessage(
          machineWs() as any,
          JSON.stringify({ type: "agent_wake_ack", agentId: "bot_1", launchId: "l_1", status: "ok" }),
        )
        await durable.webSocketMessage(
          machineWs() as any,
          JSON.stringify({ type: "agent_stopped_ack", agentId: "bot_1", launchId: "l_1", status: "ok" }),
        )

        expect(mockLogDebug).toHaveBeenCalledTimes(2)
        expect(storage.put).not.toHaveBeenCalled()
        expect(storage.delete).not.toHaveBeenCalled()
        expect(mockStubFetch).not.toHaveBeenCalled()
      })

      it("does not evict pending attribution for stopped errors or malformed wake launch ids", async () => {
        const { durable, store, storage } = createDO()
        seedIdentity(store)
        store.set("reset-pending:l_stopped", { kind: "session_reset", trigger: "single" })
        store.set("reset-pending:l_wake", { kind: "nap" })

        await durable.webSocketMessage(
          machineWs() as any,
          JSON.stringify({
            type: "agent_stopped_ack",
            agentId: "bot_1",
            launchId: "l_stopped",
            status: "error",
            error: { code: "stop_failed", message: "boom" },
          }),
        )
        await durable.webSocketMessage(
          machineWs() as any,
          JSON.stringify({
            type: "agent_wake_ack",
            agentId: "bot_1",
            launchId: 42,
            status: "error",
            error: { code: "spawn_failed", message: "boom" },
          }),
        )

        expect(store.get("reset-pending:l_stopped")).toEqual({ kind: "session_reset", trigger: "single" })
        expect(store.get("reset-pending:l_wake")).toEqual({ kind: "nap" })
        expect(storage.delete).not.toHaveBeenCalled()
      })

      it("normalizes malformed session-error payload fields without evicting a bogus launch", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"))
        const { durable, store, storage } = createDO()
        seedIdentity(store)
        store.set("reset-pending:l_keep", { kind: "nap" })

        await durable.webSocketMessage(
          machineWs() as any,
          JSON.stringify({
            type: "session.error",
            code: "runtime_not_available",
            launchId: 42,
            payload: { requested: 42, available: ["codex", 7, null] },
          }),
        )

        expect(store.get("community-machine-runtime-error")).toEqual({
          requested: "",
          available: ["codex"],
          at: "2026-08-08T00:00:00.000Z",
        })
        expect(store.get("reset-pending:l_keep")).toEqual({ kind: "nap" })
        expect(storage.delete).not.toHaveBeenCalled()
      })

      it("stops ready processing before reconciliation, handle storage, and alarm when the row is missing", async () => {
        const { durable, store, storage } = createDO()
        seedIdentity(store)
        mockUpsertMachineByMachineId.mockResolvedValue(null)

        await durable.webSocketMessage(
          machineWs() as any,
          JSON.stringify({
            type: "ready",
            runtimeReport: [],
            capabilities: ["control-heartbeat-v1"],
            runningAgents: [],
          }),
        )

        expect(mockReconcileBotActivityFromRunningAgents).not.toHaveBeenCalled()
        expect(storage.put).not.toHaveBeenCalled()
        expect(storage.setAlarm).not.toHaveBeenCalled()
      })

      it("classifies ready write failures while keeping the socket open", async () => {
        const { durable, store } = createDO()
        seedIdentity(store)
        mockUpsertMachineByMachineId.mockRejectedValue(new Error("D1 unavailable"))
        const ws = machineWs()

        await durable.webSocketMessage(
          ws as any,
          JSON.stringify({
            type: "ready",
            runtimeReport: [],
            capabilities: ["control-heartbeat-v1"],
            runningAgents: [],
          }),
        )

        expect(ws.close).not.toHaveBeenCalled()
        expect(mockLogWarn).toHaveBeenCalledWith(
          "ws_frame_dropped",
          expect.objectContaining({
            category: "ws_frame_dropped",
            frame_type: "ready",
            phase: "write",
            machineId: "cm_1",
          }),
        )
      })

      it("emits machine.updated for status or lastError drift and emits nothing for steady metadata", async () => {
        const { durable, store } = createDO()
        seedIdentity(store)
        const baseMachine = {
          id: "cm_1",
          hostname: "host",
          availableRuntimes: [{ id: "codex", version: "1", status: "unhealthy", lastError: "ENOENT" }],
          status: "online",
          lastSeenAt: "2026-08-08T00:00:00.000Z",
        }
        mockUpsertMachineByMachineId.mockResolvedValue({
          machine: baseMachine,
          priorLastSeenAt: "2026-08-07T00:00:00.000Z",
          priorAvailableRuntimes: [{ id: "codex", version: "1", status: "healthy" }],
          priorDaemonVersion: "",
          priorStatus: "online",
        })

        const driftFrame = JSON.stringify({
          type: "ready",
          runtimeReport: [{ id: "codex", version: "1", status: "unhealthy", lastError: "ENOENT" }],
          capabilities: ["control-heartbeat-v1"],
          runningAgents: [],
        })
        await durable.webSocketMessage(machineWs() as any, driftFrame)

        const driftBodies = await Promise.all(
          mockStubFetch.mock.calls.map((call: any[]) => (call[0] as Request).clone().json() as Promise<any>),
        )
        expect(driftBodies.filter((body) => body.type === "community:machine.updated")).toHaveLength(1)
        expect(driftBodies.filter((body) => body.type === "community:machine.status")).toHaveLength(0)

        mockStubFetch.mockClear()
        mockUpsertMachineByMachineId.mockResolvedValue({
          machine: baseMachine,
          priorLastSeenAt: "2026-08-08T00:00:00.000Z",
          priorAvailableRuntimes: baseMachine.availableRuntimes,
          priorDaemonVersion: "",
          priorStatus: "online",
        })

        await durable.webSocketMessage(machineWs() as any, driftFrame)

        expect(mockStubFetch).not.toHaveBeenCalled()
      })

      it("emits machine.updated when daemonVersion alone changes", async () => {
        const { durable, store } = createDO()
        seedIdentity(store)
        mockUpsertMachineByMachineId.mockResolvedValue({
          machine: {
            id: "cm_1",
            hostname: "host",
            daemonVersion: "0.1.7",
            availableRuntimes: [],
            status: "online",
            lastSeenAt: "2026-08-08T00:00:00.000Z",
          },
          priorLastSeenAt: "2026-08-07T00:00:00.000Z",
          priorAvailableRuntimes: [],
          priorDaemonVersion: "0.1.6",
          priorStatus: "online",
        })

        await durable.webSocketMessage(
          machineWs() as any,
          JSON.stringify({
            type: "ready",
            runtimeReport: [],
            capabilities: ["control-heartbeat-v1"],
            runningAgents: [],
            daemonVersion: "0.1.7",
          }),
        )

        const bodies = await Promise.all(
          mockStubFetch.mock.calls.map((call: any[]) => (call[0] as Request).clone().json() as Promise<any>),
        )
        expect(bodies.filter((body) => body.type === "community:machine.updated")).toHaveLength(1)
        expect(bodies.find((body) => body.type === "community:machine.updated")?.machine.daemonVersion).toBe("0.1.7")
      })
    })
})
