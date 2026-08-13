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

      it("keeps online state and DO identity when a replacement socket becomes ready before the old socket closes", async () => {
        const { durable, store, getWebSockets, ctx } = createDO()
        store.set("community-machine-identity", {
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "same-cmk",
        })
        store.set("community-machine-handle", { userId: "u_1", machineId: "cm_1" })
        await ctx.storage.setAlarm(Date.now() + 90_000)

        const oldSocket = createMockWebSocket()
        oldSocket.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        const newSocket = createMockWebSocket()
        newSocket.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        getWebSockets.mockReturnValue([oldSocket, newSocket])

        mockUpsertMachineByMachineId.mockResolvedValueOnce({
          machine: {
            id: "cm_1",
            hostname: "host",
            daemonVersion: "0.1.7",
            availableRuntimes: [],
            status: "online",
            lastSeenAt: "2026-08-13T08:00:00.000Z",
          },
          priorLastSeenAt: "2026-08-13T07:59:00.000Z",
          priorAvailableRuntimes: [],
          priorDaemonVersion: "0.1.6",
          priorStatus: "online",
        })
        await durable.webSocketMessage(
          newSocket as any,
          JSON.stringify({
            type: "ready",
            runtimeReport: [],
            runningAgents: [],
            daemonVersion: "0.1.7",
          }),
        )
        expect(mockUpsertMachineByMachineId).toHaveBeenCalledTimes(1)

        mockStubFetch.mockClear()
        ;(ctx.storage.deleteAlarm as any).mockClear?.()
        await durable.webSocketClose(oldSocket as any)

        expect(mockMarkMachineOffline).not.toHaveBeenCalled()
        expect(mockStubFetch).not.toHaveBeenCalled()
        expect(ctx.storage.deleteAlarm).not.toHaveBeenCalled()
        expect(store.get("community-machine-identity")).toEqual({
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "same-cmk",
        })
        expect(store.get("community-machine-handle")).toEqual({
          userId: "u_1",
          machineId: "cm_1",
        })
      })

      it("does not count the closing socket itself as a live replacement", async () => {
        const { durable, store, getWebSockets } = createDO()
        store.set("community-machine-identity", {
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "credential",
        })
        const closing = createMockWebSocket()
        closing.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        getWebSockets.mockReturnValue([closing])
        mockMarkMachineOffline.mockResolvedValueOnce(null)

        await durable.webSocketClose(closing as any)

        expect(mockMarkMachineOffline).toHaveBeenCalledTimes(1)
      })

      it("does not let different-user, different-machine, or unauthenticated sockets suppress offline", async () => {
        const { durable, store, getWebSockets } = createDO()
        store.set("community-machine-identity", {
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "credential",
        })
        const closing = createMockWebSocket()
        closing.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        const otherMachine = createMockWebSocket()
        otherMachine.serializeAttachment({
          type: "community-machine",
          machineId: "cm_2",
          userId: "u_1",
          authenticated: true,
        })
        const otherUser = createMockWebSocket()
        otherUser.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_2",
          authenticated: true,
        })
        const unauthenticated = createMockWebSocket()
        unauthenticated.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: false,
        })
        getWebSockets.mockReturnValue([closing, otherMachine, otherUser, unauthenticated])
        mockMarkMachineOffline.mockResolvedValueOnce(null)

        await durable.webSocketClose(closing as any)

        expect(mockMarkMachineOffline).toHaveBeenCalledTimes(1)
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

  describe("C2b characterization — machine lifecycle", () => {
      it("arms the exact offline retry when close-time D1 marking rejects", async () => {
        vi.spyOn(Date, "now").mockReturnValue(3_000_000)
        const { durable, store, storage } = createDO()
        store.set("community-machine-identity", {
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "hash",
        })
        mockMarkMachineOffline.mockRejectedValueOnce(new Error("d1 unavailable"))
        const ws = createMockWebSocket()
        ws.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })

        await expect(durable.webSocketClose(ws as any)).resolves.toBeUndefined()
        expect(storage.setAlarm).toHaveBeenCalledWith(3_120_000)
      })

      it("does nothing when an alarm has no live socket and no stored handle", async () => {
        const { durable, getWebSockets, storage } = createDO()
        getWebSockets.mockReturnValue([])

        await expect(durable.alarm()).resolves.toBeUndefined()

        expect(mockGetMachineByIdForUser).not.toHaveBeenCalled()
        expect(mockMarkMachineOffline).not.toHaveBeenCalled()
        expect(storage.setAlarm).not.toHaveBeenCalled()
        expect(storage.delete).not.toHaveBeenCalled()
      })

      it("cleans handle then identity when the stored machine row is missing", async () => {
        const { durable, getWebSockets, store, storage } = createDO()
        getWebSockets.mockReturnValue([])
        store.set("community-machine-handle", { userId: "u_1", machineId: "cm_1" })
        store.set("community-machine-identity", {
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "hash",
        })
        mockGetMachineByIdForUser.mockResolvedValueOnce(null)

        await durable.alarm()

        expect(storage.delete.mock.calls).toEqual([
          ["community-machine-handle"],
          ["community-machine-identity"],
        ])
        expect(storage.setAlarm).not.toHaveBeenCalled()
      })

      it("reschedules the exact heartbeat when live heartbeat touch rejects", async () => {
        vi.spyOn(Date, "now").mockReturnValue(4_000_000)
        const { durable, getWebSockets, storage } = createDO()
        const ws = createMockWebSocket()
        ws.serializeAttachment({
          type: "community-machine",
          machineId: "cm_1",
          userId: "u_1",
          authenticated: true,
        })
        getWebSockets.mockReturnValue([ws])
        mockTouchMachineHeartbeat.mockRejectedValueOnce(new Error("d1 unavailable"))

        await expect(durable.alarm()).resolves.toBeUndefined()
        expect(storage.setAlarm).toHaveBeenCalledWith(4_060_000)
      })

      it("reschedules the exact heartbeat when live online backfill rejects", async () => {
        vi.spyOn(Date, "now").mockReturnValue(5_000_000)
        const { durable, getWebSockets, store, storage } = createDO()
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
        getWebSockets.mockReturnValue([ws])
        mockTouchMachineHeartbeat.mockResolvedValueOnce({ lastSeenAt: "now", priorLastSeenAt: "before" })
        mockMarkMachineOnlineIfOffline.mockRejectedValueOnce(new Error("d1 unavailable"))

        await expect(durable.alarm()).resolves.toBeUndefined()
        expect(storage.setAlarm).toHaveBeenCalledWith(5_060_000)
      })

      it("cleans lifecycle storage when a stale offline flip rejects", async () => {
        vi.spyOn(Date, "now").mockReturnValue(6_000_000)
        const { durable, getWebSockets, store, storage } = createDO()
        getWebSockets.mockReturnValue([])
        store.set("community-machine-handle", { userId: "u_1", machineId: "cm_1" })
        store.set("community-machine-identity", {
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "hash",
        })
        mockGetMachineByIdForUser.mockResolvedValueOnce({
          id: "cm_1",
          userId: "u_1",
          status: "online",
          lastSeenAt: new Date(5_800_000).toISOString(),
          availableRuntimes: [],
        })
        mockMarkMachineOffline.mockRejectedValueOnce(new Error("d1 unavailable"))

        await expect(durable.alarm()).resolves.toBeUndefined()
        expect(storage.delete.mock.calls).toEqual([
          ["community-machine-handle"],
          ["community-machine-identity"],
        ])
        expect(storage.setAlarm).not.toHaveBeenCalled()
      })

      it("does not broadcast a stale null flip and still cleans lifecycle storage", async () => {
        vi.spyOn(Date, "now").mockReturnValue(7_000_000)
        const { durable, getWebSockets, store, storage } = createDO()
        getWebSockets.mockReturnValue([])
        store.set("community-machine-handle", { userId: "u_1", machineId: "cm_1" })
        store.set("community-machine-identity", {
          userId: "u_1",
          machineId: "cm_1",
          credentialHash: "hash",
        })
        mockGetMachineByIdForUser.mockResolvedValueOnce({
          id: "cm_1",
          userId: "u_1",
          status: "online",
          lastSeenAt: new Date(6_800_000).toISOString(),
          availableRuntimes: [],
        })
        mockMarkMachineOffline.mockResolvedValueOnce(null)
        mockStubFetch.mockClear()

        await durable.alarm()

        expect(mockStubFetch).not.toHaveBeenCalled()
        expect(storage.delete.mock.calls).toEqual([
          ["community-machine-handle"],
          ["community-machine-identity"],
        ])
      })
    })
})
