/**
 * Root Community WebSocket boundary and transport-ownership tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  capturedOnMessage,
  capturedOnReconnect,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  flushEffects,
  getStableSend,
  mountHook,
  resetCommunityWsHarness,
  resetHookInstance,
  setStableSend,
  useUserWsCallCount,
} from "./community-ws/test-harness"

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

describe("useCommunityWs — double-mount detection", () => {
  it("owns exactly one useUserWs call for one hook mount", async () => {
    await mountHook()

    expect(useUserWsCallCount).toBe(1)
    expect(capturedOnMessage).not.toBeNull()
    expect(capturedOnReconnect).not.toBeNull()
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
