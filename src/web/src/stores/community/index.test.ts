import { beforeEach, describe, expect, it, vi } from "vitest"
import { useCommunityStore } from "./index"

beforeEach(() => {
  useCommunityStore.getState().reset()
})

describe("useCommunityStore", () => {
  it("has the expected initial shape", () => {
    const s = useCommunityStore.getState()
    expect(s.currentServerId).toBeNull()
    expect(s.currentChannelId).toBeNull()
    expect(s.currentChannelMeta).toBeNull()
    expect(s.typingByScope).toBeInstanceOf(Map)
    expect(s.typingByScope.size).toBe(0)
    expect(s.typingTimers).toBeInstanceOf(Map)
    expect(s.typingTimers.size).toBe(0)
    expect(s.lastTypingSent.size).toBe(0)
    expect(s.reactionTimers.size).toBe(0)
    expect(s.pendingMachineTokenId).toBeNull()
    expect(s.secondaryChannelOwner).toBeNull()
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
    expect(useCommunityStore.getState().subscription).toEqual({ channelId: "c1" })

    useCommunityStore.getState().subscribe({ dmConversationId: "d1" })
    expect(useCommunityStore.getState().subscription).toEqual({
      dmConversationId: "d1",
    })

    useCommunityStore.getState().unsubscribe()
    expect(useCommunityStore.getState().subscription).toEqual({})
  })

  it("sets and clears the split-view secondary channel without replacing the primary", () => {
    const store = useCommunityStore.getState()
    const owner = Symbol("split")
    store.subscribe({ channelId: "thread" })

    store.claimSecondaryChannel(owner, "parent")
    expect(useCommunityStore.getState().subscription).toEqual({
      channelId: "thread",
      secondaryChannelId: "parent",
    })

    const first = useCommunityStore.getState().subscription
    store.claimSecondaryChannel(owner, "parent")
    expect(useCommunityStore.getState().subscription).toBe(first)

    store.releaseSecondaryChannel(owner)
    expect(useCommunityStore.getState().subscription).toEqual({ channelId: "thread" })
  })

  it("preserves the owned secondary channel when the primary route re-subscribes", () => {
    const store = useCommunityStore.getState()
    const owner = Symbol("split")
    store.subscribe({ channelId: "thread_1" })
    store.claimSecondaryChannel(owner, "parent")

    store.subscribe({ channelId: "thread_2" })
    expect(useCommunityStore.getState().subscription).toEqual({
      channelId: "thread_2",
      secondaryChannelId: "parent",
    })
    expect(useCommunityStore.getState().secondaryChannelOwner).toBe(owner)
  })

  it("does not let a stale split cleanup erase the current secondary or primary", () => {
    const store = useCommunityStore.getState()
    const staleOwner = Symbol("stale")
    const currentOwner = Symbol("current")
    store.subscribe({ channelId: "thread_2" })
    store.claimSecondaryChannel(staleOwner, "parent_1")
    store.claimSecondaryChannel(currentOwner, "parent_2")

    store.releaseSecondaryChannel(staleOwner)
    expect(useCommunityStore.getState().subscription).toEqual({
      channelId: "thread_2",
      secondaryChannelId: "parent_2",
    })

    store.releaseSecondaryChannel(currentOwner)
    expect(useCommunityStore.getState().subscription).toEqual({ channelId: "thread_2" })
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
        typingTimers.set("ch:c1|user1", timerId)
        const typingByScope = new Map(prev.typingByScope)
        typingByScope.set("ch:c1", new Set(["user1"]))
        const lastTypingSent = new Map(prev.lastTypingSent)
        lastTypingSent.set("c1", Date.now())
        const reactionTimers = new Map(prev.reactionTimers)
        const rTimer = setTimeout(() => {}, 1_000)
        reactionTimers.set("m1:emoji", { timer: rTimer, originalMe: false })
        return {
          typingByScope,
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
      expect(after.typingByScope.size).toBe(0)
      expect(after.typingTimers.size).toBe(0)
      expect(after.lastTypingSent.size).toBe(0)
      expect(after.reactionTimers.size).toBe(0)
      expect(after.pendingMachineTokenId).toBeNull()
      expect(after.secondaryChannelOwner).toBeNull()
      expect(after.subscription).toEqual({})
      expect(after.uiHandlers).toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("typingByScope isolation", () => {
  // The `useTypingUsersForScope` hook is a thin `useShallow` wrapper over these
  // reads (exercised through React in `use-community-ws.test.ts`); the node
  // test env has no DOM, so here we assert the underlying scoped-Map shape that
  // the selector reads — one scope's typers never bleed into another.
  const seed = (entries: Record<string, string[]>) => {
    useCommunityStore.setState({
      typingByScope: new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)])),
    })
  }
  const read = (scopeKey: string) => {
    const set = useCommunityStore.getState().typingByScope.get(scopeKey)
    return set ? Array.from(set) : []
  }

  it("keeps each scope's typers separate; an unrelated scope reads empty", () => {
    seed({ "dm:d1": ["u1"], "ch:c1": ["u2", "u3"] })
    expect(read("dm:d1")).toEqual(["u1"])
    expect(read("ch:c1")).toEqual(["u2", "u3"])
    // A scope with no typers reads as empty — no leak from the populated scopes.
    expect(read("ch:c2")).toEqual([])
  })
})
