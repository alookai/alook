import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CommunityBotAuditEvent,
  CommunityMachineCreated,
  CommunityMachineStatus,
  CommunityMachineSummary,
  CommunityMachineUpdated,
  CommunityMachineRemoved,
  CommunityPresenceUpdate,
  CommunityStatusUpdate,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import type { MachinesResponse } from "@/hooks/community/use-machines"
import {
  capturedOnMessage,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  mountHook,
  resetCommunityWsHarness,
} from "./test-harness"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — presence", () => {
  it("presence.update writes only to the canonical profile map", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedQueryClient.setQueryData(communityKeys.friendsPresence(), {
      online: ["friend_existing"],
    })
    const event: CommunityPresenceUpdate = {
      type: "community:presence.update",
      userId: "u_pres",
      online: true,
    }
    capturedOnMessage!(event)
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(useCommunityWsStore.getState().profilesByUserId.get("u_pres")?.presence).toBe("online")
    expect(capturedQueryClient.getQueryData(communityKeys.friendsPresence())).toEqual({
      online: ["friend_existing"],
    })
    const patchedSnapshot = capturedQueryClient.getQueryData(communityKeys.friendsPresence())
    capturedOnMessage!(event)
    expect(capturedQueryClient.getQueryData(communityKeys.friendsPresence())).toBe(patchedSnapshot)
    expect(spy).not.toHaveBeenCalled()
  })

  it("applies an exact offline delta without mutating presence query snapshots", async () => {
    await mountHook()
    const { useCommunityWsStore } = await import("@/stores/community/ws")

    capturedQueryClient.setQueryData(communityKeys.friendsPresence(), {
      online: ["friend_non_member"],
    })
    const store = useCommunityWsStore.getState()
    store.patchProfiles(store.beginProfileSnapshot(), [{
      id: "friend_non_member",
      presence: "online",
    }])

    const offline: CommunityPresenceUpdate = {
      type: "community:presence.update",
      userId: "friend_non_member",
      online: false,
    }
    capturedOnMessage!(offline)
    expect(useCommunityWsStore.getState().profilesByUserId.get("friend_non_member")?.presence)
      .toBe("offline")
    expect(capturedQueryClient.getQueryData(communityKeys.friendsPresence()))
      .toEqual({ online: ["friend_non_member"] })
  })

  it("does not create a friends presence cache from a live delta alone", async () => {
    await mountHook()
    capturedOnMessage!({
      type: "community:presence.update",
      userId: "u_pres",
      online: true,
    } satisfies CommunityPresenceUpdate)

    expect(capturedQueryClient.getQueryData(communityKeys.friendsPresence())).toBeUndefined()
  })

})
describe("useCommunityWs — status.update → Zustand store, no cache", () => {
  it("status.update writes to useCommunityWsStore only", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event: CommunityStatusUpdate = {
      type: "community:status.update",
      userId: "u_status",
      statusEmoji: "🎧",
      statusText: "Vibing",
    }
    capturedOnMessage!(event)
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(useCommunityWsStore.getState().profilesByUserId.get("u_status")).toMatchObject({
      statusEmoji: "🎧",
      statusText: "Vibing",
    })
    // No cache touched.
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("useCommunityWs — bot audit events", () => {
  it("accepts and stores a live daemon-accepted turn interrupt", async () => {
    await mountHook()
    const event: CommunityBotAuditEvent = {
      type: "community:bot.audit_event",
      botId: "bot_stop",
      id: "audit_stop",
      kind: "turn_interrupt",
      payload: { status: "accepted" },
      sessionId: "session_1",
      launchId: "launch_1",
      createdAt: "2026-09-01T15:00:00.000Z",
    }

    capturedOnMessage!(event)

    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(useCommunityWsStore.getState().botAuditEvents.get("bot_stop")).toEqual([{
      id: "audit_stop",
      botId: "bot_stop",
      kind: "turn_interrupt",
      payload: { status: "accepted" },
      sessionId: "session_1",
      launchId: "launch_1",
      createdAt: "2026-09-01T15:00:00.000Z",
    }])
  })
})

describe("useCommunityWs — machines", () => {
  const machine = (id: string, status: "online" | "offline" = "offline"): CommunityMachineSummary => ({
    id, hostname: id, displayName: id, platform: "darwin", arch: "arm64",
    osRelease: "24", daemonVersion: "0.1", lastSeenAt: null, status,
    availableRuntimes: [], createdAt: "2026-07-03T00:00:00.000Z", updatedAt: "2026-07-03T00:00:00.000Z",
  })
  const capacity = {
    plan: { id: "house", displayName: "House" }, isFounder: true,
    limit: 10, ownedCount: 1, onlineCount: 0,
  }
  const readCache = () => capturedQueryClient.getQueryData<MachinesResponse>(communityKeys.machines())

  it.each(["created", "updated"] as const)("machine.%s upserts without double-counting and preserves the allowance", async (kind) => {
    await mountHook()
    const original = machine("existing")
    capturedQueryClient.setQueryData(communityKeys.machines(), { machines: [original], machineCapacity: capacity })
    const inserted = machine("new", "online")
    const dispatch = (value: CommunityMachineSummary) => {
      capturedOnMessage!(kind === "created"
        ? { type: "community:machine.created", tokenId: "cmt_live", machine: value } satisfies CommunityMachineCreated
        : { type: "community:machine.updated", machine: value } satisfies CommunityMachineUpdated)
    }
    dispatch(inserted)
    expect(readCache()).toEqual({ machines: [inserted, original], machineCapacity: { ...capacity, ownedCount: 2, onlineCount: 1 } })
    dispatch(inserted)
    expect(readCache()?.machines).toHaveLength(2)
    const replacement = { ...inserted, status: "offline" as const, displayName: "Renamed" }
    dispatch(replacement)
    expect(readCache()).toEqual({ machines: [replacement, original], machineCapacity: { ...capacity, ownedCount: 2 } })
    if (kind === "created") {
      const { useCommunityStore } = await import("@/stores/community")
      expect(useCommunityStore.getState().pendingMachineTokenId).toBe("cmt_live")
    }
  })

  it("status changes online usage; removal alone frees owned slots and tolerates replay", async () => {
    await mountHook()
    const offline = machine("offline")
    const online = machine("online", "online")
    capturedQueryClient.setQueryData(communityKeys.machines(), {
      machines: [offline, online], machineCapacity: { ...capacity, ownedCount: 2, onlineCount: 1 },
    })
    const status: CommunityMachineStatus = {
      type: "community:machine.status", machineId: "online", status: "offline", lastSeenAt: "2026-07-03T01:00:00.000Z",
    }
    capturedOnMessage!(status)
    expect(readCache()).toEqual({
      machines: [offline, { ...online, status: "offline", lastSeenAt: status.lastSeenAt }],
      machineCapacity: { ...capacity, ownedCount: 2 },
    })
    capturedOnMessage!({ ...status, machineId: "unknown", status: "online" })
    expect(readCache()?.machineCapacity).toEqual({ ...capacity, ownedCount: 2 })
    const removed: CommunityMachineRemoved = { type: "community:machine.removed", machineId: "online" }
    capturedOnMessage!(removed)
    capturedOnMessage!(removed)
    expect(readCache()).toEqual({ machines: [offline], machineCapacity: capacity })
  })

  it("ignores status/removal without a snapshot and bootstraps update without inventing allowance", async () => {
    await mountHook()
    capturedOnMessage!({ type: "community:machine.status", machineId: "new", status: "online", lastSeenAt: "2026-07-03T01:00:00.000Z" } satisfies CommunityMachineStatus)
    capturedOnMessage!({ type: "community:machine.removed", machineId: "new" } satisfies CommunityMachineRemoved)
    expect(readCache()).toBeUndefined()
    const event: CommunityMachineUpdated = { type: "community:machine.updated", machine: machine("new") }
    capturedOnMessage!(event)
    expect(readCache()).toEqual({ machines: [event.machine] })
  })

  it("machine.created upserts and stashes pending token", async () => {
    await mountHook()
    const created: CommunityMachineCreated = {
      type: "community:machine.created",
      tokenId: "cmt_abc",
      machine: {
        id: "m_1",
        hostname: "h",
        displayName: "d",
        platform: "darwin",
        arch: "arm64",
        osRelease: "24",
        daemonVersion: "0.1",
        lastSeenAt: null,
        status: "online",
        availableRuntimes: [],
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(created)
    expect(
      capturedQueryClient.getQueryData<{ machines: { id: string }[] }>(communityKeys.machines())?.machines,
    ).toHaveLength(1)
    const { useCommunityStore } = await import("@/stores/community")
    expect(useCommunityStore.getState().pendingMachineTokenId).toBe("cmt_abc")
  })

  it("machine.status patches lastSeenAt/status only", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.machines(), {
      machines: [
        {
          id: "m_1",
          hostname: "h",
          displayName: "d",
          platform: "darwin",
          arch: "arm64",
          osRelease: "24",
          daemonVersion: "0.1",
          lastSeenAt: null,
          status: "online",
          availableRuntimes: [],
          createdAt: "",
          updatedAt: "",
        },
      ],
    })
    const status: CommunityMachineStatus = {
      type: "community:machine.status",
      machineId: "m_1",
      status: "offline",
      lastSeenAt: "2026-07-03T00:00:00.000Z",
    }
    capturedOnMessage!(status)
    const cache = capturedQueryClient.getQueryData<{ machines: { status: string; lastSeenAt: string | null }[] }>(
      communityKeys.machines(),
    )
    expect(cache?.machines[0].status).toBe("offline")
    expect(cache?.machines[0].lastSeenAt).toBe("2026-07-03T00:00:00.000Z")
  })
})
