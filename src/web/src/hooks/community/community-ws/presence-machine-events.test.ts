import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CommunityMachineCreated,
  CommunityMachineStatus,
  CommunityPresenceUpdate,
  CommunityStatusUpdate,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import {
  capturedOnMessage,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  mountHook,
  resetCommunityWsHarness,
} from "./test-harness"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — presence → Zustand store, no cache", () => {
  it("presence.update writes to useCommunityWsStore only", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event: CommunityPresenceUpdate = {
      type: "community:presence.update",
      userId: "u_pres",
      online: true,
    }
    capturedOnMessage!(event)
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(useCommunityWsStore.getState().onlineUserIds.has("u_pres")).toBe(true)
    // No cache touched.
    expect(spy).not.toHaveBeenCalled()
  })

  it("fires the legacy presence callback exactly once", async () => {
    const onPresence = vi.fn()
    await mountHook({ onPresence })
    const event: CommunityPresenceUpdate = {
      type: "community:presence.update",
      userId: "u_callback",
      online: false,
    }

    capturedOnMessage!(event)

    expect(onPresence).toHaveBeenCalledOnce()
    expect(onPresence).toHaveBeenCalledWith(event)
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
    expect(useCommunityWsStore.getState().userStatuses.get("u_status")).toEqual({
      emoji: "🎧",
      text: "Vibing",
    })
    // No cache touched.
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("useCommunityWs — machines", () => {
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
