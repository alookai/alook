import { beforeEach, describe, expect, it, vi } from "vitest"
import { useCommunityStore } from "./index"

// Mock the mark-reads flush so we can assert `reset()` invokes it without
// the real implementation firing HTTP requests. `vi.mock` is hoisted above
// regular `const` declarations, so we stash the spy in `vi.hoisted(...)`
// which the hoisted mock factory can safely reference.
const { flushPendingReadsSpy } = vi.hoisted(() => ({
  flushPendingReadsSpy: vi.fn(),
}))
vi.mock("@/hooks/community/mutations/messages", () => ({
  flushPendingReads: flushPendingReadsSpy,
}))

// Each test starts from a clean slate — otherwise Zustand's module-scoped
// store would leak state (and lingering timers) between cases. `reset()`
// schedules a dynamic-imported flush via a microtask; wait until the spy
// fires before clearing it — otherwise the pending callback would bleed
// into the next test's count.
beforeEach(async () => {
  useCommunityStore.getState().reset()
  await vi.waitFor(() => expect(flushPendingReadsSpy).toHaveBeenCalled())
  flushPendingReadsSpy.mockClear()
})

describe("useCommunityStore", () => {
  it("has the expected initial shape", () => {
    const s = useCommunityStore.getState()
    expect(s.currentServerId).toBeNull()
    expect(s.currentChannelId).toBeNull()
    expect(s.currentChannelMeta).toBeNull()
    expect(s.typingUsers).toEqual([])
    expect(s.typingTimers).toBeInstanceOf(Map)
    expect(s.typingTimers.size).toBe(0)
    expect(s.lastTypingSent.size).toBe(0)
    expect(s.reactionTimers.size).toBe(0)
    expect(s.pendingMachineTokenId).toBeNull()
    expect(s.subscription).toEqual({})
    expect(s.uiHandlers).toEqual({})
  })

  it("setCurrentServerId updates state", () => {
    useCommunityStore.getState().setCurrentServerId("s1")
    expect(useCommunityStore.getState().currentServerId).toBe("s1")

    useCommunityStore.getState().setCurrentServerId(null)
    expect(useCommunityStore.getState().currentServerId).toBeNull()
  })

  it("setCurrentChannelId and setCurrentChannelMeta update state", () => {
    useCommunityStore.getState().setCurrentChannelId("c1")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "general",
      parentChannelId: null,
      parentMessageId: null,
    })
    const s = useCommunityStore.getState()
    expect(s.currentChannelId).toBe("c1")
    expect(s.currentChannelMeta).toEqual({
      name: "general",
      parentChannelId: null,
      parentMessageId: null,
    })
  })

  it("subscribe / unsubscribe mutate the subscription slot", () => {
    useCommunityStore.getState().subscribe({ channelId: "c1" })
    expect(useCommunityStore.getState().subscription).toEqual({
      channelId: "c1",
    })

    useCommunityStore.getState().subscribe({ dmConversationId: "d1" })
    expect(useCommunityStore.getState().subscription).toEqual({
      dmConversationId: "d1",
    })

    useCommunityStore.getState().unsubscribe()
    expect(useCommunityStore.getState().subscription).toEqual({})
  })

  it("subscribe bails out when the target is unchanged (identity foot-gun fix)", () => {
    // The pre-fix behaviour spread `{ ...target }` on every call, producing a
    // fresh object even when the pointers were identical — every subscriber
    // via `useCommunitySubscription` would re-render. After the fix, the
    // second identical subscribe is a no-op and the reference stays stable.
    useCommunityStore.getState().subscribe({ channelId: "c1" })
    const first = useCommunityStore.getState().subscription
    useCommunityStore.getState().subscribe({ channelId: "c1" })
    const second = useCommunityStore.getState().subscription
    expect(second).toBe(first)

    // Different target — fresh reference expected.
    useCommunityStore.getState().subscribe({ channelId: "c2" })
    const third = useCommunityStore.getState().subscription
    expect(third).not.toBe(second)
    expect(third).toEqual({ channelId: "c2" })

    // Unsubscribe → empty. Second unsubscribe is a no-op → same reference.
    useCommunityStore.getState().unsubscribe()
    const fourth = useCommunityStore.getState().subscription
    useCommunityStore.getState().unsubscribe()
    expect(useCommunityStore.getState().subscription).toBe(fourth)
  })

  it("setPendingMachineTokenId updates state", () => {
    useCommunityStore.getState().setPendingMachineTokenId("cmt_abc")
    expect(useCommunityStore.getState().pendingMachineTokenId).toBe("cmt_abc")

    useCommunityStore.getState().setPendingMachineTokenId(null)
    expect(useCommunityStore.getState().pendingMachineTokenId).toBeNull()
  })

  it("registerUiHandlers merges rather than replaces", () => {
    const previewImage = vi.fn()
    const openProfile = vi.fn()
    useCommunityStore.getState().registerUiHandlers({ previewImage })
    expect(useCommunityStore.getState().uiHandlers.previewImage).toBe(previewImage)

    useCommunityStore.getState().registerUiHandlers({ openProfile })
    // previewImage stays even though we only passed openProfile.
    expect(useCommunityStore.getState().uiHandlers.previewImage).toBe(previewImage)
    expect(useCommunityStore.getState().uiHandlers.openProfile).toBe(openProfile)
  })

  it("reset flushes pending mark-reads before wiping state", async () => {
    // `reset()` uses a dynamic import to avoid a circular dependency with
    // `mutations/messages`. The `import()` resolves asynchronously — poll
    // via `vi.waitFor` instead of assuming a fixed microtask count.
    useCommunityStore.getState().reset()
    await vi.waitFor(() => expect(flushPendingReadsSpy).toHaveBeenCalledTimes(1))
  })

  it("reset clears every field including timer maps", () => {
    vi.useFakeTimers()
    try {
      const s = useCommunityStore.getState()

      // Populate all mutable slots so reset has something to clear.
      s.setCurrentServerId("s1")
      s.setCurrentChannelId("c1")
      s.setCurrentChannelMeta({
        name: "general",
        parentChannelId: null,
      })
      s.subscribe({ channelId: "c1" })
      s.setPendingMachineTokenId("cmt_abc")
      s.registerUiHandlers({ previewImage: vi.fn() })

      // Inject a live timer to prove reset clears it, not just the reference.
      const fired = vi.fn()
      const timerId = setTimeout(fired, 1_000)
      // Mutate the state's Maps directly — matches how the WS handler will
      // populate typingTimers before the migration is finished.
      useCommunityStore.setState((prev) => {
        const typingTimers = new Map(prev.typingTimers)
        typingTimers.set("user1", timerId)
        const lastTypingSent = new Map(prev.lastTypingSent)
        lastTypingSent.set("c1", Date.now())
        const reactionTimers = new Map(prev.reactionTimers)
        const rTimer = setTimeout(() => {}, 1_000)
        reactionTimers.set("m1:emoji", { timer: rTimer, originalMe: false })
        return {
          typingUsers: ["user1"],
          typingTimers,
          lastTypingSent,
          reactionTimers,
        }
      })

      useCommunityStore.getState().reset()

      // Advancing timers past their delay must NOT fire the callback — reset
      // called clearTimeout on it.
      vi.advanceTimersByTime(5_000)
      expect(fired).not.toHaveBeenCalled()

      const after = useCommunityStore.getState()
      expect(after.currentServerId).toBeNull()
      expect(after.currentChannelId).toBeNull()
      expect(after.currentChannelMeta).toBeNull()
      expect(after.typingUsers).toEqual([])
      expect(after.typingTimers.size).toBe(0)
      expect(after.lastTypingSent.size).toBe(0)
      expect(after.reactionTimers.size).toBe(0)
      expect(after.pendingMachineTokenId).toBeNull()
      expect(after.subscription).toEqual({})
      expect(after.uiHandlers).toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })
})
