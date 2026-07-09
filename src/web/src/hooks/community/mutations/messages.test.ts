/**
 * Mutation-hook tests for message-scoped operations.
 *
 * The vitest environment is node (no jsdom / react rendering). We drive the
 * hook body by mocking `useMutation` + `useQueryClient` so we can capture
 * the config object and invoke `onMutate` → `mutationFn` → `onSuccess`/
 * `onError` manually. Same qc is used for cache assertions before/after each
 * step.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

// ── React shim (mirrors use-community-ws.test.ts) ────────────────────────
let refs: Map<string, { current: unknown }> = new Map()
let refCounter = 0
let callbackMemo: Map<string, { fn: Function; deps: unknown[] }> = new Map()
let callbackCounter = 0

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) refs.set(id, { current: initial })
    return refs.get(id)!
  },
  useCallback: (fn: Function, deps: unknown[]) => {
    const id = `cb-${callbackCounter++}`
    const existing = callbackMemo.get(id)
    if (existing && JSON.stringify(existing.deps) === JSON.stringify(deps)) {
      return existing.fn
    }
    callbackMemo.set(id, { fn, deps })
    return fn
  },
  useEffect: () => {},
  useState: (initial: unknown) => [initial, () => {}],
}))

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

// Sonner toast — we assert on the string arg for the blocked-DM test.
const toastMock = vi.fn()
vi.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => toastMock(...args), {
    error: (...args: unknown[]) => toastMock(...args),
    success: (...args: unknown[]) => toastMock(...args),
  }),
}))

// Captured mutation config the mocked `useMutation` returns.
type MutConfig<Args, Ctx> = {
  mutationFn?: (args: Args) => unknown
  onMutate?: (args: Args) => Promise<Ctx> | Ctx
  onSuccess?: (data: unknown, args: Args, ctx: Ctx) => unknown
  onError?: (err: unknown, args: Args, ctx: Ctx) => unknown
}
let capturedConfig: MutConfig<unknown, unknown> | null = null
let capturedQc: QueryClient
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQc,
    useMutation: (config: MutConfig<unknown, unknown>) => {
      capturedConfig = config
      return {}
    },
  }
})

async function runMutation<Args>(args: Args) {
  const cfg = capturedConfig as MutConfig<Args, unknown>
  const ctx = cfg.onMutate ? await cfg.onMutate(args) : undefined
  try {
    const data = cfg.mutationFn ? await cfg.mutationFn(args) : undefined
    cfg.onSuccess?.(data, args, ctx)
    return { data, ctx }
  } catch (err) {
    cfg.onError?.(err, args, ctx)
    throw err
  }
}

async function loadMod() {
  vi.resetModules()
  return await import("./messages")
}

function makeCache(msgs: { id: string; failed?: boolean; reactions?: unknown[] }[] = []) {
  return {
    pages: [{ messages: msgs, hasMore: false }],
    pageParams: [null],
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
  toastMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
  refs = new Map()
  refCounter = 0
  callbackMemo = new Map()
  callbackCounter = 0
})

// ── useSendMessage ────────────────────────────────────────────────────────

describe("useSendMessage — happy path", () => {
  it("optimistic insert then reconciles server id on success", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    apiFetchMock.mockResolvedValueOnce({ message: { id: "server_id_1" } })

    const mod = await loadMod()
    mod.useSendMessage() // populate capturedConfig
    await runMutation({
      channelId: "ch_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    })

    const cache = capturedQc.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages.map((m) => m.id)).toEqual(["server_id_1"])
  })
})

describe("useSendMessage — rollback", () => {
  it("marks the optimistic row as failed on server error", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useSendMessage()
    await runMutation({
      channelId: "ch_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pages: { messages: { id: string; failed?: boolean }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toHaveLength(1)
    expect(cache?.pages[0].messages[0].failed).toBe(true)
  })
})

// Regression pin — the mount-time effect in <MessageList> gates self-send
// auto-scroll on `tail.authorId === viewerUserId`. A missing `authorId` on
// the optimistic row silently disables that scroll, so pin the field on
// BOTH the channel and DM optimistic paths.
describe("useSendMessage — stamps authorId on optimistic row", () => {
  it("optimistic row carries the sender's authorId", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    // Never resolves — we only care about the optimistic write from onMutate.
    apiFetchMock.mockImplementation(() => new Promise(() => {}))
    const mod = await loadMod()
    mod.useSendMessage()
    const cfg = capturedConfig!
    await cfg.onMutate!({
      channelId: "ch_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    })
    const cache = capturedQc.getQueryData<{ pages: { messages: { authorId?: string }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toHaveLength(1)
    expect(cache?.pages[0].messages[0].authorId).toBe("u_me")
  })
})

// ── useSendDmMessage ──────────────────────────────────────────────────────

describe("useSendDmMessage — stamps authorId on optimistic row", () => {
  // Companion regression: without authorId the self-send auto-scroll bails
  // in <MessageList> because `undefined !== viewerUserId`. Pin the field.
  it("optimistic DM row carries the sender's authorId", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    apiFetchMock.mockImplementation(() => new Promise(() => {}))
    const mod = await loadMod()
    mod.useSendDmMessage()
    const cfg = capturedConfig!
    await cfg.onMutate!({
      dmId: "dm_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    })
    const cache = capturedQc.getQueryData<{ pages: { messages: { authorId?: string }[] }[] }>(
      communityKeys.dmMessages("dm_1"),
    )
    expect(cache?.pages[0].messages).toHaveLength(1)
    expect(cache?.pages[0].messages[0].authorId).toBe("u_me")
  })
})

describe("useSendDmMessage — rollback", () => {
  it("marks the temp DM row failed on server failure", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useSendDmMessage()
    await runMutation({
      dmId: "dm_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pages: { messages: { failed?: boolean }[] }[] }>(
      communityKeys.dmMessages("dm_1"),
    )
    expect(cache?.pages[0].messages[0].failed).toBe(true)
  })
})

describe("useSendDmMessage — 403 blocked special-case", () => {
  it("removes the temp row and fires the scoped toast, no failed:true state", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    const mod = await loadMod()
    // Import ApiError AFTER loadMod so it resolves against the SAME module
    // instance the hook's `err instanceof ApiError` check will see.
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("blocked", 403))
    mod.useSendDmMessage()
    await runMutation({
      dmId: "dm_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pages: { messages: unknown[] }[] }>(
      communityKeys.dmMessages("dm_1"),
    )
    // Temp row scrubbed — no bubble, no failed:true.
    expect(cache?.pages[0].messages).toHaveLength(0)
    expect(toastMock).toHaveBeenCalledWith("You cannot send messages to this user")
  })

  it("regression: a generic 500 still marks the row failed and fires no blocked toast", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("boom", 500))
    mod.useSendDmMessage()
    await runMutation({
      dmId: "dm_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pages: { messages: { failed?: boolean }[] }[] }>(
      communityKeys.dmMessages("dm_1"),
    )
    expect(cache?.pages[0].messages).toHaveLength(1)
    expect(cache?.pages[0].messages[0].failed).toBe(true)
    expect(toastMock).not.toHaveBeenCalled()
  })
})

// 429 rate-limit toasts on both channel and DM send paths — the pill stays
// as `failed: true` so the retry affordance is still visible, but a toast
// fires so the user knows why the send didn't go through.
describe("useSendMessage — 429 rate limit fires a toast + marks failed", () => {
  it("channel 429: toast fires and row is marked failed:true", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("rate_limited", 429))
    mod.useSendMessage()
    await runMutation({
      channelId: "ch_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pages: { messages: { failed?: boolean }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages[0].failed).toBe(true)
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining("Rate limited"))
  })
})

describe("useSendDmMessage — 429 rate limit fires a toast + marks failed", () => {
  it("DM 429: toast fires and row is marked failed:true (not scrubbed like 403 blocked)", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("rate_limited", 429))
    mod.useSendDmMessage()
    await runMutation({
      dmId: "dm_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pages: { messages: { failed?: boolean }[] }[] }>(
      communityKeys.dmMessages("dm_1"),
    )
    expect(cache?.pages[0].messages).toHaveLength(1)
    expect(cache?.pages[0].messages[0].failed).toBe(true)
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining("Rate limited"))
  })
})

// Regression guard — channel path stays generic-error, never fires the blocked
// toast even on 403 blocked (that shouldn't happen on channels; ensure the
// hook doesn't accidentally add DM's onBlocked branch to `useSendMessage`).
describe("useSendMessage — no blocked branch on channel path", () => {
  it("403 blocked on channel POST still marks failed:true and skips the DM toast", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("blocked", 403))
    mod.useSendMessage()
    await runMutation({
      channelId: "ch_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pages: { messages: { failed?: boolean }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toHaveLength(1)
    expect(cache?.pages[0].messages[0].failed).toBe(true)
    expect(toastMock).not.toHaveBeenCalled()
  })
})

// ── useToggleReaction ─────────────────────────────────────────────────────

describe("useToggleReaction — optimistic flip + rollback", () => {
  it("optimistically adds a reaction with me=true and issues PUT", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [{ id: "m_1", reactions: [] }], hasMore: false }],
      pageParams: [null],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mod.useToggleReaction()
    await runMutation({
      channelId: "ch_1",
      messageId: "m_1",
      emoji: "👍",
      userId: "u_me",
    })
    const cache = capturedQc.getQueryData<{
      pages: { messages: { reactions: { emoji: string; me: boolean }[] }[] }[]
    }>(communityKeys.channelMessages("ch_1"))
    expect(cache?.pages[0].messages[0].reactions).toMatchObject([{ emoji: "👍", me: true }])
    expect(apiFetchMock).toHaveBeenCalledWith(expect.any(String), { method: "PUT" })
  })

  it("rolls back on failure — reactions return to []", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [{ id: "m_1", reactions: [] }], hasMore: false }],
      pageParams: [null],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useToggleReaction()
    await runMutation({
      channelId: "ch_1",
      messageId: "m_1",
      emoji: "👍",
      userId: "u_me",
    }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pages: { messages: { reactions: unknown[] }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages[0].reactions).toEqual([])
  })
})

// ── useToggleReactionApi — the #9 300ms debounce ────────────────────────
//
// Old context (context.tsx:1061-1130) captured `originalMe` at first click,
// scheduled the API in a 300ms timer, and either replaced or cancelled the
// timer on subsequent clicks. Step 3's hook dropped the coalescing; this
// restores it via useCommunityStore.reactionTimers.
describe("useToggleReactionApi — 300ms debounce coalescing", () => {
  it("5 rapid clicks with alternating me→!me→me settle to a SINGLE API call at end of window", async () => {
    vi.useFakeTimers()
    try {
      // Baseline: server-side reactions=[], me=false.
      capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), {
        pages: [{ messages: [{ id: "m_1", reactions: [] }], hasMore: false }],
        pageParams: [null],
      })
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetReactionTimers_forTesting()
      const toggle = mod.useToggleReactionApi()
      // 5 rapid taps — cache flips each call, but only the final settled
      // state is what should fire against the server.
      // originalMe (server) = false; after 5 flips me ends up true → PUT.
      for (let i = 0; i < 5; i++) {
        toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      }
      // Nothing yet — everything's debounced.
      expect(apiFetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(apiFetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/community/messages/m_1/reactions/"),
        { method: "PUT" },
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("flip-back (net-zero) cancels the timer — zero API calls fire", async () => {
    vi.useFakeTimers()
    try {
      capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), {
        pages: [{ messages: [{ id: "m_1", reactions: [] }], hasMore: false }],
        pageParams: [null],
      })
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetReactionTimers_forTesting()
      const toggle = mod.useToggleReactionApi()
      // Toggle on → toggle off within 300ms. originalMe=false, terminal me=false.
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      await vi.advanceTimersByTimeAsync(500)
      expect(apiFetchMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("triple-toggle net = one flip → exactly one API call at end of window", async () => {
    vi.useFakeTimers()
    try {
      capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), {
        pages: [{ messages: [{ id: "m_1", reactions: [] }], hasMore: false }],
        pageParams: [null],
      })
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetReactionTimers_forTesting()
      const toggle = mod.useToggleReactionApi()
      // originalMe=false. Toggle-toggle-toggle → terminal me=true → PUT.
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      expect(apiFetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(apiFetchMock.mock.calls[0][1]).toEqual({ method: "PUT" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("useCommunityStore.reset() before the timer fires cancels the pending API call", async () => {
    vi.useFakeTimers()
    try {
      capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), {
        pages: [{ messages: [{ id: "m_1", reactions: [] }], hasMore: false }],
        pageParams: [null],
      })
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      const { useCommunityStore } = await import("@/stores/community")
      useCommunityStore.getState().reset()
      const toggle = mod.useToggleReactionApi()
      toggle({ channelId: "ch_1", messageId: "m_1", emoji: "👍", userId: "u_me" })
      // Simulate sign-out unmount — reset() clears timer maps.
      useCommunityStore.getState().reset()
      await vi.advanceTimersByTimeAsync(500)
      expect(apiFetchMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── usePinMessage ─────────────────────────────────────────────────────────

describe("usePinMessage — invalidates pins on success", () => {
  it("triggers invalidateQueries on pins(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mod.usePinMessage()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ channelId: "ch_1", messageId: "m_1" })
    expect(
      spy.mock.calls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("pins")
      }),
    ).toBe(true)
  })
})

// ── useUnpinMessage ───────────────────────────────────────────────────────

describe("useUnpinMessage — rollback", () => {
  it("removes optimistically and restores on failure", async () => {
    capturedQc.setQueryData(communityKeys.pins("ch_1"), { pins: [{ id: "m_1", content: "hi" }] })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useUnpinMessage()
    await runMutation({ channelId: "ch_1", messageId: "m_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ pins: unknown[] }>(communityKeys.pins("ch_1"))
    expect(cache?.pins).toHaveLength(1)
  })
})

// ── useCreateThread ───────────────────────────────────────────────────────

describe("useCreateThread — patches parent message + invalidates threads", () => {
  it("adds thread indicator to the parent message with messageCount: 0", async () => {
    // Regression: previously patched messageCount=1 on the assumption that
    // the parent message was cloned into the thread. #6 removed the
    // parent-clone, so new threads start empty. `messageCount` MUST be 0
    // to avoid the UI showing "1 reply" on an empty thread.
    capturedQc.setQueryData(communityKeys.channelMessages("ch_parent"), {
      pages: [{ messages: [{ id: "m_p" }], hasMore: false }],
      pageParams: [null],
    })
    apiFetchMock.mockResolvedValueOnce({ id: "thr_1" })
    const mod = await loadMod()
    mod.useCreateThread()
    await runMutation({ channelId: "ch_parent", messageId: "m_p", name: "Discussion" })
    const cache = capturedQc.getQueryData<{
      pages: { messages: { id: string; thread?: { id: string; name: string; messageCount: number } }[] }[]
    }>(communityKeys.channelMessages("ch_parent"))
    expect(cache?.pages[0].messages[0].thread).toEqual({ id: "thr_1", name: "Discussion", messageCount: 0 })
  })
})

// ── useMarkChannelRead — the #13 debounce ─────────────────────────────────

describe("useMarkChannelRead — #13 debounced read stampede", () => {
  // Drive mutationFn directly (bypassing runMutation) so the test doesn't
  // have to await 9 pending promises that intentionally never resolve —
  // the debounce coalesces them into one that fires the timer callback.
  it("10 rapid triggers collapse into ONE PUT /read after the debounce window", async () => {
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      mod.useMarkChannelRead()
      const cfg = capturedConfig!
      // Fire 10 rapid triggers — each schedules (and cancels the previous)
      // debounce timer. Only the last one survives.
      for (let i = 0; i < 10; i++) {
        void cfg.mutationFn!({ channelId: "ch_1" })
      }
      // Nothing before the debounce window closes.
      expect(apiFetchMock.mock.calls.filter((c) => (c[1] as { method?: string })?.method === "PUT")).toHaveLength(
        0,
      )
      await vi.advanceTimersByTimeAsync(500)
      const puts = apiFetchMock.mock.calls.filter((c) => (c[1] as { method?: string })?.method === "PUT")
      expect(puts).toHaveLength(1)
      expect(puts[0][0]).toBe("/api/community/channels/ch_1/read")
    } finally {
      vi.useRealTimers()
    }
  })

  it("flushPendingReads() fires any pending PUT synchronously", async () => {
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      mod.useMarkChannelRead()
      const cfg = capturedConfig!
      // Kick the debounce.
      void cfg.mutationFn!({ channelId: "ch_1" })
      // Flush before the 500ms window elapses — should fire the PUT now.
      mod.flushPendingReads()
      const puts = apiFetchMock.mock.calls.filter((c) => (c[1] as { method?: string })?.method === "PUT")
      expect(puts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("mutationFn resolves synchronously — never hangs when flushed or re-invoked", async () => {
    // Regression: the old implementation wrapped setTimeout inside the
    // mutation Promise. A same-channel re-invoke cleared the timer, which
    // meant the resolve() was unreachable and the Promise hung forever.
    // The new design decouples the debounce from mutationFn — the returned
    // Promise resolves immediately, and the debounced work fires
    // independently via `scheduleMarkRead`'s onDone.
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      mod.useMarkChannelRead()
      const cfg = capturedConfig!
      // Fire the mutation, then flush before the debounce window closes.
      const first = cfg.mutationFn!({ channelId: "ch_1" }) as Promise<void>
      // Same-channel re-invoke — old bug would strand the first Promise.
      const second = cfg.mutationFn!({ channelId: "ch_1" }) as Promise<void>
      mod.flushPendingReads()
      // Both Promises must have resolved (not thrown, not hung).
      await expect(first).resolves.toBeUndefined()
      await expect(second).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("onDone (inbox invalidate) fires exactly once per PUT — even under flush", async () => {
    // Real timers here — we need Promise microtasks to drain naturally
    // after `apiFetch` resolves, so `onDone` (invalidateQueries) runs.
    apiFetchMock.mockResolvedValue(undefined)
    const mod = await loadMod()
    mod._resetPendingReads_forTesting()
    mod.useMarkChannelRead()
    const cfg = capturedConfig!
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    // One mutation, then flush. `fire()` runs apiFetch → onDone chain.
    void cfg.mutationFn!({ channelId: "ch_1" })
    mod.flushPendingReads()
    // Drain microtasks — the `.then(onDone)` after apiFetch resolves.
    await Promise.resolve()
    await Promise.resolve()
    const inboxInvalidates = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.length === 2 && key[0] === "community" && key[1] === "inbox"
    })
    expect(inboxInvalidates).toHaveLength(1)
  })

  it("onDone also invalidates communityKeys.servers() so the rail badge drops", async () => {
    // Marking a channel read clears its unread mentions on the server; the
    // rail badge is derived from the same aggregate, so it must refresh.
    apiFetchMock.mockResolvedValue(undefined)
    const mod = await loadMod()
    mod._resetPendingReads_forTesting()
    mod.useMarkChannelRead()
    const cfg = capturedConfig!
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    void cfg.mutationFn!({ channelId: "ch_1" })
    mod.flushPendingReads()
    await Promise.resolve()
    await Promise.resolve()
    const serversInvalidates = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.length === 2 && key[0] === "community" && key[1] === "servers"
    })
    expect(serversInvalidates).toHaveLength(1)
  })

  it("same-channel re-invoke within window collapses to a single PUT — old scheduling is subsumed", async () => {
    // Regression companion to the Promise-hang bug: verify the debounce
    // behavior itself still holds. A rapid burst on the same channel must
    // collapse to ONE PUT, and the pending map must not leak entries.
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      mod.useMarkChannelRead()
      const cfg = capturedConfig!
      void cfg.mutationFn!({ channelId: "ch_1" })
      void cfg.mutationFn!({ channelId: "ch_1" })
      void cfg.mutationFn!({ channelId: "ch_1" })
      expect(apiFetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(500)
      const puts = apiFetchMock.mock.calls.filter((c) => (c[1] as { method?: string })?.method === "PUT")
      expect(puts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("useMarkChannelRead fires PUT with NO body — the mass mark-read path", async () => {
    // The extended `scheduleMarkRead` accepts an optional messageId. The
    // no-messageId call site (useMarkChannelRead → useMarkAllInboxRead)
    // must NOT send a body — the server treats absence as "mark whole
    // channel read at now".
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      mod.useMarkChannelRead()
      const cfg = capturedConfig!
      void cfg.mutationFn!({ channelId: "ch_1" })
      await vi.advanceTimersByTimeAsync(500)
      const put = apiFetchMock.mock.calls.find(
        (c) => (c[1] as { method?: string })?.method === "PUT",
      )
      expect(put).toBeDefined()
      // No `body` key on the init.
      expect((put![1] as RequestInit).body).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── scheduleMarkRead — extended signature (with messageId body) ──────────
describe("scheduleMarkRead — with messageId body", () => {
  it("posts { lastReadMessageId } when a messageId is passed", async () => {
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      mod.scheduleMarkRead("ch_1", { messageId: "m_42", onDone: () => {} })
      await vi.advanceTimersByTimeAsync(500)
      const put = apiFetchMock.mock.calls.find(
        (c) => (c[1] as { method?: string })?.method === "PUT",
      )
      expect(put).toBeDefined()
      expect((put![1] as RequestInit).body).toBe(JSON.stringify({ lastReadMessageId: "m_42" }))
    } finally {
      vi.useRealTimers()
    }
  })

  it("supersedes the pending messageId when a newer one arrives mid-window", async () => {
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      mod.scheduleMarkRead("ch_1", { messageId: "m_stale", onDone: () => {} })
      // Fresh call within the window — the latest messageId wins.
      mod.scheduleMarkRead("ch_1", { messageId: "m_fresh", onDone: () => {} })
      await vi.advanceTimersByTimeAsync(500)
      const puts = apiFetchMock.mock.calls.filter(
        (c) => (c[1] as { method?: string })?.method === "PUT",
      )
      expect(puts).toHaveLength(1)
      expect((puts[0][1] as RequestInit).body).toBe(JSON.stringify({ lastReadMessageId: "m_fresh" }))
    } finally {
      vi.useRealTimers()
    }
  })

  it("no messageId → no body (preserves the mass mark-read path)", async () => {
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      mod.scheduleMarkRead("ch_1", { onDone: () => {} })
      await vi.advanceTimersByTimeAsync(500)
      const put = apiFetchMock.mock.calls.find(
        (c) => (c[1] as { method?: string })?.method === "PUT",
      )
      expect((put![1] as RequestInit).body).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── useAdvanceChannelWatermark — thin wrapper for viewport advances ─────
describe("useAdvanceChannelWatermark", () => {
  it("returns a callable that PUTs { lastReadMessageId } after the debounce", async () => {
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      const advance = mod.useAdvanceChannelWatermark()
      advance("ch_1", "m_42")
      await vi.advanceTimersByTimeAsync(500)
      const put = apiFetchMock.mock.calls.find(
        (c) => (c[1] as { method?: string })?.method === "PUT",
      )
      expect(put).toBeDefined()
      expect((put![0] as string)).toBe("/api/community/channels/ch_1/read")
      expect((put![1] as RequestInit).body).toBe(JSON.stringify({ lastReadMessageId: "m_42" }))
    } finally {
      vi.useRealTimers()
    }
  })

  it("onDone invalidates inbox + servers after the PUT resolves", async () => {
    apiFetchMock.mockResolvedValue(undefined)
    const mod = await loadMod()
    mod._resetPendingReads_forTesting()
    const advance = mod.useAdvanceChannelWatermark()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    advance("ch_1", "m_42")
    mod.flushPendingReads()
    // Drain the `.then(onDone)` microtask chain.
    await Promise.resolve()
    await Promise.resolve()
    const inboxCalls = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.includes("inbox")
    })
    const serversCalls = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.length === 2 && key[1] === "servers"
    })
    expect(inboxCalls.length).toBeGreaterThanOrEqual(1)
    expect(serversCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ── useAdvanceDmWatermark — DM sibling of the channel wrapper ───────────
describe("useAdvanceDmWatermark", () => {
  it("returns a callable that PUTs { lastReadMessageId } to the DM read route", async () => {
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      const advance = mod.useAdvanceDmWatermark()
      advance("dm_1", "m_42")
      await vi.advanceTimersByTimeAsync(500)
      const put = apiFetchMock.mock.calls.find(
        (c) => (c[1] as { method?: string })?.method === "PUT",
      )
      expect(put).toBeDefined()
      expect(put![0] as string).toBe("/api/community/dm/dm_1/read")
      expect((put![1] as RequestInit).body).toBe(
        JSON.stringify({ lastReadMessageId: "m_42" }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("DM and channel schedules share the debounce map but don't alias each other", async () => {
    // Regression: the "dm:<id>" namespace makes a DM schedule and a
    // channel schedule with the same underlying id coexist in the same
    // pendingReads map. If they aliased, one would clobber the other's
    // pointer and one of the two PUTs would go missing.
    vi.useFakeTimers()
    try {
      apiFetchMock.mockResolvedValue(undefined)
      const mod = await loadMod()
      mod._resetPendingReads_forTesting()
      const advanceDm = mod.useAdvanceDmWatermark()
      const advanceCh = mod.useAdvanceChannelWatermark()
      // Same underlying id `x` — one DM, one channel.
      advanceDm("x", "m_dm")
      advanceCh("x", "m_ch")
      await vi.advanceTimersByTimeAsync(500)
      const puts = apiFetchMock.mock.calls.filter(
        (c) => (c[1] as { method?: string })?.method === "PUT",
      )
      expect(puts).toHaveLength(2)
      const dmPut = puts.find((c) => (c[0] as string).startsWith("/api/community/dm/"))
      const chPut = puts.find((c) =>
        (c[0] as string).startsWith("/api/community/channels/"),
      )
      expect(dmPut).toBeDefined()
      expect(chPut).toBeDefined()
      expect((dmPut![1] as RequestInit).body).toBe(
        JSON.stringify({ lastReadMessageId: "m_dm" }),
      )
      expect((chPut![1] as RequestInit).body).toBe(
        JSON.stringify({ lastReadMessageId: "m_ch" }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("onDone invalidates inbox + dms after the PUT resolves", async () => {
    apiFetchMock.mockResolvedValue(undefined)
    const mod = await loadMod()
    mod._resetPendingReads_forTesting()
    const advance = mod.useAdvanceDmWatermark()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    advance("dm_1", "m_42")
    mod.flushPendingReads()
    await Promise.resolve()
    await Promise.resolve()
    const inboxCalls = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.includes("inbox")
    })
    const dmsCalls = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.length === 2 && key[1] === "dms"
    })
    expect(inboxCalls.length).toBeGreaterThanOrEqual(1)
    expect(dmsCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ── useMarkDmRead — rollback ──────────────────────────────────────────────

describe("useMarkDmRead — rollback", () => {
  it("optimistically clears unread; restores on failure", async () => {
    capturedQc.setQueryData(communityKeys.dms(), {
      conversations: [{ id: "dm_1", unread: true }],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useMarkDmRead()
    await runMutation({ dmId: "dm_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ conversations: { id: string; unread?: boolean }[] }>(
      communityKeys.dms(),
    )
    expect(cache?.conversations[0].unread).toBe(true)
  })
})

// ── useMarkAllInboxRead ───────────────────────────────────────────────────

describe("useMarkAllInboxRead", () => {
  it("fires exactly two POSTs — mentions read-all + unreads read-all", async () => {
    capturedQc.setQueryData(communityKeys.inboxUnreads(), { servers: [] })
    capturedQc.setQueryData(communityKeys.inboxMentions(), { mentions: [] })
    apiFetchMock.mockResolvedValue(undefined)
    const mod = await loadMod()
    mod.useMarkAllInboxRead()
    await runMutation<void>(undefined as unknown as void)
    const posts = apiFetchMock.mock.calls.filter(
      (c) => (c[1] as { method?: string })?.method === "POST",
    )
    expect(posts).toHaveLength(2)
    const paths = posts.map((c) => c[0] as string).sort()
    expect(paths).toEqual([
      "/api/community/inbox/mentions/read-all",
      "/api/community/inbox/unreads/read-all",
    ])
  })

  it("clears both inbox caches optimistically", async () => {
    capturedQc.setQueryData(communityKeys.inboxUnreads(), {
      servers: [{ serverId: "s_1", serverName: "s", channels: [{ channelId: "ch_1" }] }],
    })
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    apiFetchMock.mockResolvedValue(undefined)
    const mod = await loadMod()
    mod.useMarkAllInboxRead()
    await runMutation<void>(undefined as unknown as void)
    expect(capturedQc.getQueryData(communityKeys.inboxUnreads())).toEqual({ servers: [], dms: [] })
    expect(capturedQc.getQueryData(communityKeys.inboxMentions())).toEqual({ mentions: [] })
  })

  it("onSuccess invalidates communityKeys.servers() so every rail badge drops to 0", async () => {
    // Mark-all-read clears every unread mention row on the server — the rail
    // aggregate must refresh across all servers, not just the inbox feeds.
    apiFetchMock.mockResolvedValue(undefined)
    const mod = await loadMod()
    mod.useMarkAllInboxRead()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation<void>(undefined as unknown as void)
    const serversInvalidates = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.length === 2 && key[0] === "community" && key[1] === "servers"
    })
    expect(serversInvalidates.length).toBeGreaterThanOrEqual(1)
  })
})

// ── useDeleteMention — rollback ──────────────────────────────────────────

describe("useDeleteMention — rollback", () => {
  it("restores mention on failure", async () => {
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mod.useDeleteMention()
    await runMutation({ mentionId: "men_1" }).catch(() => {})
    const cache = capturedQc.getQueryData<{ mentions: { id: string }[] }>(
      communityKeys.inboxMentions(),
    )
    expect(cache?.mentions).toHaveLength(1)
  })

  it("invalidates communityKeys.servers() on success so the rail badge decrements", async () => {
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mod.useDeleteMention()
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ mentionId: "men_1" })
    const serversInvalidates = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.length === 2 && key[0] === "community" && key[1] === "servers"
    })
    expect(serversInvalidates).toHaveLength(1)
  })
})
