/**
 * Root Community WebSocket boundary and transport-ownership tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  capturedConnectionStateChange,
  capturedOnMessage,
  capturedOnReconnect,
  capturedQueryClient,
  capturedUseUserWsOptions,
  cleanupCommunityWsHarness,
  flushEffects,
  getStableReconnectNow,
  getStableSend,
  mountHook,
  resetCommunityWsHarness,
  resetHookInstance,
  setStableSend,
  useUserWsCallCount,
} from "./community-ws/test-harness"
import {
  COMMUNITY_WS_FAILED_AFTER_MS,
  COMMUNITY_WS_RECONNECTING_GRACE_MS,
} from "./community-ws/connection-status"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — non-community events bail", () => {
  it("rejects non-community and unknown community-prefixed events", async () => {
    await mountHook()
    const setSpy = vi.spyOn(capturedQueryClient, "setQueryData")
    const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!({ type: "task.updated", taskId: "t_1" })
    capturedOnMessage!({ type: "community:unknown", serverId: "srv_1" })
    expect(setSpy).not.toHaveBeenCalled()
    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})

describe("useCommunityWs — public helper contracts", () => {
  it("returns void after mounting the single root transport", async () => {
    expect(await mountHook({ viewerUserId: "u_viewer" })).toBeUndefined()
  })

  it("free subscribe/unsubscribe helpers preserve then clear both subscription slots", async () => {
    const { communityWsSubscribe, communityWsUnsubscribe } = await import("./use-community-ws")
    const { useCommunityStore } = await import("@/stores/community")
    const target = { channelId: "ch_contract", dmConversationId: "dm_contract" }

    communityWsSubscribe(target)
    expect(useCommunityStore.getState().subscription).toEqual(target)

    communityWsUnsubscribe()
    expect(useCommunityStore.getState().subscription.channelId).toBeUndefined()
    expect(useCommunityStore.getState().subscription.dmConversationId).toBeUndefined()
  })

  it("free typing helpers no-op before mount, throttle, and send again after reset", async () => {
    const { communityWsResetTypingThrottle, communityWsSendTyping } = await import("./use-community-ws")
    const target = { channelId: "ch_typing_contract" }

    communityWsSendTyping(target)
    expect(getStableSend()).not.toHaveBeenCalled()

    await mountHook()
    flushEffects()
    const send = getStableSend()
    communityWsSendTyping(target)
    communityWsSendTyping(target)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenNthCalledWith(1, {
      type: "community:typing.start",
      channelId: "ch_typing_contract",
    })

    communityWsResetTypingThrottle(target)
    communityWsSendTyping(target)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(2, {
      type: "community:typing.start",
      channelId: "ch_typing_contract",
    })
  })
})

describe("useCommunityWs — connection status publication", () => {
  it("publishes the grace, failed, authenticated, and manual retry states from the root", async () => {
    vi.useFakeTimers()
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    await mountHook()
    flushEffects()

    capturedConnectionStateChange!("reconnecting")
    expect(useCommunityWsStore.getState().connectionStatus).toBe("connected")
    vi.advanceTimersByTime(COMMUNITY_WS_RECONNECTING_GRACE_MS)
    expect(useCommunityWsStore.getState().connectionStatus).toBe("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS - COMMUNITY_WS_RECONNECTING_GRACE_MS)
    expect(useCommunityWsStore.getState().connectionStatus).toBe("failed")

    useCommunityWsStore.getState().reconnectNow()
    expect(useCommunityWsStore.getState().connectionStatus).toBe("reconnecting")
    expect(getStableReconnectNow()).toHaveBeenCalledOnce()

    capturedConnectionStateChange!("authenticated")
    expect(useCommunityWsStore.getState().connectionStatus).toBe("connected")

    capturedConnectionStateChange!("reconnecting")
    expect(useCommunityWsStore.getState().connectionStatus).toBe("reconnecting")
  })

  it("suspends threshold timers and re-arms on the next visible reconnect", async () => {
    vi.useFakeTimers()
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    await mountHook()
    flushEffects()

    capturedConnectionStateChange!("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_RECONNECTING_GRACE_MS)
    capturedConnectionStateChange!("suspended")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(useCommunityWsStore.getState().connectionStatus).toBe("connected")

    capturedConnectionStateChange!("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_RECONNECTING_GRACE_MS)
    expect(useCommunityWsStore.getState().connectionStatus).toBe("reconnecting")
  })

  it("keeps resume validation quiet until transport failure and clears recovery once", async () => {
    vi.useFakeTimers()
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    await mountHook()
    flushEffects()

    capturedConnectionStateChange!("reconnecting")
    capturedConnectionStateChange!("authenticated")
    capturedConnectionStateChange!("suspended")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS + 1)
    expect(useCommunityWsStore.getState().connectionStatus).toBe("connected")

    capturedConnectionStateChange!("authenticated")
    expect(useCommunityWsStore.getState().connectionStatus).toBe("connected")

    capturedConnectionStateChange!("reconnecting")
    expect(useCommunityWsStore.getState().connectionStatus).toBe("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(useCommunityWsStore.getState().connectionStatus).toBe("failed")

    capturedConnectionStateChange!("authenticated")
    expect(useCommunityWsStore.getState().connectionStatus).toBe("connected")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(useCommunityWsStore.getState().connectionStatus).toBe("connected")
  })
})

describe("useCommunityWs — double-mount detection", () => {
  it("owns exactly one useUserWs call for one hook mount", async () => {
    await mountHook()

    expect(useUserWsCallCount).toBe(1)
    expect(capturedOnMessage).not.toBeNull()
    expect(capturedOnReconnect).not.toBeNull()
    expect(capturedUseUserWsOptions?.requestDaemonStatusOnAuth).toBe(false)
    expect(capturedUseUserWsOptions).not.toHaveProperty("capabilities")
  })

  it("emits console.warn when a second instance mounts with a different send", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { })
    try {
      // First mount publishes the current stable `send` into activeSend.
      await mountHook()
      flushEffects()
      // Simulate a second, independent hook site returning a different `send`
      // by swapping the shared stub before the second mount.
      setStableSend(vi.fn())
      // Reset ref counters so the shim hands out fresh refs (mimics a second
      // hook site — not a re-render of the first).
      resetHookInstance()
      await mountHook()
      flushEffects()
      expect(
        warnSpy.mock.calls.some((c) =>
          typeof c[0] === "string" && c[0].includes("Multiple instances"),
        ),
      ).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("does NOT warn on a normal re-render (same send identity)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { })
    try {
      await mountHook()
      flushEffects()
      // Re-mount with the SAME stableSend — should be a no-op for the guard.
      resetHookInstance()
      await mountHook()
      flushEffects()
      expect(
        warnSpy.mock.calls.some((c) =>
          typeof c[0] === "string" && c[0].includes("Multiple instances"),
        ),
      ).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
