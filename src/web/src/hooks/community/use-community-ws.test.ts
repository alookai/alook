/**
 * Community WS handler tests.
 *
 * The vitest environment is node (no jsdom), so we drive the hook body via a
 * minimal React shim — same approach as the pre-migration test file. The
 * hook now writes to the TanStack Query cache; we assert those writes rather
 * than callback invocations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type {
  CommunityMessageCreate,
  CommunityMessageEdited,
  CommunityReactionAdd,
  CommunityMemberJoin,
  CommunityMemberUpdate,
  CommunityMachineCreated,
  CommunityMachineStatus,
  CommunityPresenceUpdate,
  CommunityStatusUpdate,
  CommunityMentionCreate,
  CommunityServerUpdate,
  CommunityServerDelete,
  CommunityChannelCreate,
  CommunityChannelDelete,
  CommunityChildChannelCreate,
  CommunityChildChannelUpdate,
  CommunityPinAdd,
  CommunityFriendRequest,
  CommunityTypingStart,
} from "@alook/shared"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import { communityKeys } from "@/lib/query-keys"

// ── React shim ───────────────────────────────────────────────────────────
let refs: Map<string, { current: unknown }> = new Map()
let refCounter = 0
let stateCounter = 0
let callbackMemo: Map<string, { fn: Function; deps: unknown[] }> = new Map()
let callbackCounter = 0
// Captured effect callbacks — tests can flush them via `flushEffects()`.
let pendingEffects: Array<() => void> = []

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const id = `ref-${refCounter++}`
    if (!refs.has(id)) refs.set(id, { current: initial })
    return refs.get(id)!
  },
  useState: (initial: unknown) => [initial, () => { }],
  useCallback: (fn: Function, deps: unknown[]) => {
    const id = `cb-${callbackCounter++}`
    const existing = callbackMemo.get(id)
    if (existing && JSON.stringify(existing.deps) === JSON.stringify(deps)) {
      return existing.fn
    }
    callbackMemo.set(id, { fn, deps })
    return fn
  },
  useEffect: (fn: () => void, _deps: unknown[]) => {
    pendingEffects.push(fn)
  },
}))

function flushEffects() {
  const effects = pendingEffects
  pendingEffects = []
  for (const fn of effects) fn()
}

// Shared QueryClient instance the hook resolves via useQueryClient.
let capturedQueryClient: QueryClient
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQueryClient,
  }
})

// Capture the callback passed into useUserWs so tests can drive it. The
// `send` binding is stable across re-mounts within one test so the module-
// level `activeSend` guard in `useCommunityWs` sees the same identity — a
// fresh spy per mount would trip the double-mount detector on every remount.
let capturedOnMessage: ((msg: unknown) => void) | null = null
let capturedOnReconnect: (() => void) | null = null
let stableSend: ReturnType<typeof vi.fn> = vi.fn()
vi.mock("@/lib/use-user-ws", () => ({
  useUserWs: (onMessage: (msg: unknown) => void, options?: { onReconnect?: () => void }) => {
    capturedOnMessage = onMessage
    capturedOnReconnect = options?.onReconnect ?? null
    return { send: stableSend }
  },
}))

// #3: `useCommunityWs` no longer calls `useMarkChannelRead` — the WS-driven
// auto-mark-read was replaced by the viewport IntersectionObserver in
// `useChannelWatermark`. The mock still exists because `flushPendingReads`
// is imported by the community store's `reset()`. The `markReadMutate` spy
// is used by the regression test below that asserts the WS handler NEVER
// invokes it, even for foreign-authored messages in the focused channel.
const markReadMutate = vi.fn()
vi.mock("@/hooks/community/mutations/messages", () => ({
  useMarkChannelRead: () => ({ mutate: markReadMutate }),
  flushPendingReads: () => { },
}))

function resetHarness() {
  refs = new Map()
  refCounter = 0
  stateCounter = 0
  callbackMemo = new Map()
  callbackCounter = 0
  pendingEffects = []
  capturedOnMessage = null
  capturedOnReconnect = null
  capturedQueryClient = new QueryClient()
  stableSend = vi.fn()
  markReadMutate.mockClear()
}

async function mountHook(options?: { viewerUserId?: string | null } & Record<string, unknown>) {
  const mod = await import("./use-community-ws")
  return mod.useCommunityWs(options)
}

// Reset store state before each test — the store is module-scoped.
async function resetStore() {
  const { useCommunityStore } = await import("@/stores/community")
  useCommunityStore.getState().reset()
  useCommunityStore.getState().setCurrentServerId("s1")
  const { useCommunityWsStore } = await import("@/stores/community/ws")
  useCommunityWsStore.getState().reset()
  useMessageStreamStore.getState().resetAll()
  const mod = await import("./use-community-ws")
  mod._resetActiveSend_forTesting()
}

beforeEach(async () => {
  resetHarness()
  await resetStore()
})

// ── Fixtures ─────────────────────────────────────────────────────────────

function messageCreate(channelId: string, msgId = "m_1"): CommunityMessageCreate {
  return {
    type: "community:message.create",
    channelId,
    message: {
      id: msgId,
      seq: Number(msgId.match(/\d+$/)?.[0] ?? 1),
      type: "chat",
      authorId: "u_author",
      authorName: "author",
      content: "hi",
      createdAt: "2026-07-03T00:00:00.000Z",
    },
  }
}

function unreadBump(
  channelId: string,
  userId: string,
  extra?: { serverId?: string; railChannelId?: string; isMention?: boolean },
) {
  return { type: "community:unread.bump" as const, userId, channelId, ...extra }
}

describe("useCommunityWs — message.create", () => {
  it("writes the channel overlay and leaves the base cache untouched when focused", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })

    // Re-mount so the ref state picks up the subscription value.
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    // Seed a page cache so setQueryData has something to patch.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })

    capturedOnMessage!(messageCreate("ch_1"))

    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toEqual([])
    expect([...getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById]).toHaveLength(1)
  })

  it("heals a first-seen event replay once the focused serverId becomes available", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId(null)
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    const event = messageCreate("ch_1")
    capturedOnMessage!(event)
    expect(getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById).toHaveLength(0)

    useCommunityStore.getState().setCurrentServerId("s1")
    capturedOnMessage!(event)
    expect(getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById).toHaveLength(1)
  })

  it("does NOT patch a channel we aren't focused on", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_other"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })
    capturedOnMessage!(messageCreate("ch_other"))
    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_other"),
    )
    expect(cache?.pages[0].messages).toEqual([])
  })

  it("invalidates threadParticipants for the focused channel (live panel growth)", async () => {
    // A child thread enrolls the sender + mentioned users in its notify set.
    // server-side; the panel must refetch so a new speaker appears without a
    // manual refresh.
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!(messageCreate("ch_1"))

    expect(spy).toHaveBeenCalledWith({ queryKey: communityKeys.threadParticipants("ch_1") })
  })

  it("does NOT invalidate threadParticipants for an unfocused channel", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!(messageCreate("ch_other"))
    const calls = spy.mock.calls.filter(
      (c) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(communityKeys.threadParticipants("ch_other")),
    )
    expect(calls).toHaveLength(0)
  })

  it("dedupes by messageId — a repeat event is a no-op", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })
    capturedOnMessage!(messageCreate("ch_1"))
    capturedOnMessage!(messageCreate("ch_1"))
    capturedOnMessage!(messageCreate("ch_1"))
    expect(getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById.size).toBe(1)
  })

  it("caps the live page at MAX_LIVE_PAGE_MESSAGES, dropping the oldest entry", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    const MAX_LIVE_PAGE_MESSAGES = 500
    const seeded = Array.from({ length: MAX_LIVE_PAGE_MESSAGES }, (_, i) => ({
      id: `seed_${i}`,
      content: "x",
      createdAt: "2026-07-03T00:00:00.000Z",
    }))
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: seeded, hasMore: false }],
      pageParams: [null],
    })

    capturedOnMessage!(messageCreate("ch_1", "new_message"))

    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    const ids = cache?.pages[0].messages.map((m) => m.id) ?? []
    expect(ids).toHaveLength(MAX_LIVE_PAGE_MESSAGES)
    expect(ids[0]).toBe("seed_0")
    expect(ids).not.toContain("new_message")
    expect(getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById.has("new_message")).toBe(true)
  })

  it("flips hasMore/hasMoreOlder to true when the head-slice discards history (legacy shape)", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    const MAX_LIVE_PAGE_MESSAGES = 500
    const seeded = Array.from({ length: MAX_LIVE_PAGE_MESSAGES }, (_, i) => ({
      id: `seed_${i}`,
      content: "x",
      createdAt: "2026-07-03T00:00:00.000Z",
    }))
    // Legacy newest-mode envelope: only `hasMore` is defined.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: seeded, hasMore: false }],
      pageParams: [null],
    })

    capturedOnMessage!(messageCreate("ch_1", "new_message"))

    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string }[]; hasMore?: boolean; hasMoreOlder?: boolean }[]
    }>(communityKeys.channelMessages("ch_1"))
    // Head-slice discarded seed_0; the "Load older" affordance must re-arm
    // via `hasMore: true` (legacy shape had no `hasMoreOlder` so we don't
    // synthesize it).
    expect(cache?.pages[0].hasMore).toBe(false)
    expect(cache?.pages[0].hasMoreOlder).toBeUndefined()
  })

  it("flips hasMoreOlder to true on head-slice for anchor-mode envelopes", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    const MAX_LIVE_PAGE_MESSAGES = 500
    const seeded = Array.from({ length: MAX_LIVE_PAGE_MESSAGES }, (_, i) => ({
      id: `seed_${i}`,
      content: "x",
      createdAt: "2026-07-03T00:00:00.000Z",
    }))
    // Anchor-mode envelope: hasMoreOlder + hasMoreNewer, no `hasMore`.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: seeded, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 42 }],
      pageParams: [{ mode: "anchor", anchor: "seed_0" }],
    })

    capturedOnMessage!(messageCreate("ch_1", "new_message"))

    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string }[]; hasMore?: boolean; hasMoreOlder?: boolean; hasMoreNewer?: boolean }[]
    }>(communityKeys.channelMessages("ch_1"))
    expect(cache?.pages[0].hasMoreOlder).toBe(false)
    // We must NOT invent a legacy `hasMore` flag on an anchor envelope —
    // the two shapes are mutually exclusive.
    expect(cache?.pages[0].hasMore).toBeUndefined()
    // `hasMoreNewer` untouched.
    expect(cache?.pages[0].hasMoreNewer).toBe(false)
  })

  it("does not touch hasMore flags when the page hasn't been trimmed", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [
        {
          messages: [{ id: "seed_0", content: "x", createdAt: "t" }],
          hasMoreOlder: false,
          hasMoreNewer: false,
          latestSeq: 1,
        },
      ],
      pageParams: [null],
    })
    capturedOnMessage!(messageCreate("ch_1", "m_new"))
    const cache = capturedQueryClient.getQueryData<{
      pages: { hasMoreOlder?: boolean; hasMoreNewer?: boolean }[]
    }>(communityKeys.channelMessages("ch_1"))
    expect(cache?.pages[0].hasMoreOlder).toBe(false)
    expect(cache?.pages[0].hasMoreNewer).toBe(false)
  })

  it("does not drop below the cap when the page isn't at capacity yet", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [{ id: "seed_0", content: "x", createdAt: "t" }], hasMore: false }],
      pageParams: [null],
    })
    capturedOnMessage!(messageCreate("ch_1", "m_new"))
    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages.map((m) => m.id)).toEqual(["seed_0"])
    expect(getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById.has("m_new")).toBe(true)
  })

  it("does not schedule an inbox invalidate for viewer's own messages", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "u_author" })
      const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
      capturedOnMessage!(messageCreate("ch_random"))
      vi.advanceTimersByTime(1_000)
      expect(invalidateSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("debounces inbox invalidation — 10 messages ⇒ 1 invalidate call", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "u_me" })
      const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
      for (let i = 0; i < 10; i++) capturedOnMessage!(messageCreate("ch_x", `m_${i}`))
      // Before debounce window, no invalidate.
      expect(invalidateSpy).not.toHaveBeenCalled()
      // Advance past the debounce window — exactly one invalidate.
      vi.advanceTimersByTime(500)
      const inboxCalls = invalidateSpy.mock.calls.filter((c) => {
        const key = c[0]?.queryKey
        return Array.isArray(key) && key.includes("inbox")
      })
      expect(inboxCalls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── Channel-sidebar live unread patch (plans/community-unread-indicators.md) ─
describe("useCommunityWs — message.create patches channel unread in the open server's cache", () => {
  function serverDetailFixture(channelId: string) {
    return {
      id: "srv_open",
      name: "Server",
      description: "",
      icon: null,
      ownerId: "u_owner",
      categories: [
        { id: "cat_A", name: "Category A", channels: [{ id: channelId, name: "random", active: false, unread: false }] },
      ],
    }
  }

  it("flips the channel's unread to true on unread.bump when it belongs to the currently-open server's cached ServerDetail", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    capturedQueryClient.setQueryData(communityKeys.server("srv_open"), serverDetailFixture("ch_random"))

    capturedOnMessage!(unreadBump("ch_random", "u_me"))

    const cache = capturedQueryClient.getQueryData<{
      categories: { channels: { id: string; unread: boolean }[] }[]
    }>(communityKeys.server("srv_open"))
    expect(cache?.categories[0].channels[0]).toMatchObject({ id: "ch_random", unread: true })
  })

  it("message.create alone does NOT flip the sidebar unread (mute-gated bump is the only trigger now)", async () => {
    // Regression pin: mute ≠ blindness. The message.create still arrives (and
    // content syncs), but the unread dot is flipped ONLY by the server's
    // per-recipient, mute-gated unread.bump — so a muted channel's message.create
    // must NOT light the dot. Don't "fix" this back onto message.create.
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    capturedQueryClient.setQueryData(communityKeys.server("srv_open"), serverDetailFixture("ch_random"))

    capturedOnMessage!(messageCreate("ch_random"))

    const cache = capturedQueryClient.getQueryData<{
      categories: { channels: { id: string; unread: boolean }[] }[]
    }>(communityKeys.server("srv_open"))
    expect(cache?.categories[0].channels[0].unread).toBe(false)
  })

  it("does NOT flip unread on a bump addressed to a different user", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    capturedQueryClient.setQueryData(communityKeys.server("srv_open"), serverDetailFixture("ch_random"))

    capturedOnMessage!(unreadBump("ch_random", "someone_else"))

    const cache = capturedQueryClient.getQueryData<{
      categories: { channels: { id: string; unread: boolean }[] }[]
    }>(communityKeys.server("srv_open"))
    expect(cache?.categories[0].channels[0].unread).toBe(false)
  })

  it("does NOT flip unread for the currently-subscribed (active) channel", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    useCommunityStore.getState().subscribe({ channelId: "ch_random" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook({ viewerUserId: "u_me" })
    capturedQueryClient.setQueryData(communityKeys.server("srv_open"), serverDetailFixture("ch_random"))

    capturedOnMessage!(unreadBump("ch_random", "u_me"))

    const cache = capturedQueryClient.getQueryData<{
      categories: { channels: { id: string; unread: boolean }[] }[]
    }>(communityKeys.server("srv_open"))
    expect(cache?.categories[0].channels[0].unread).toBe(false)
  })

  it("is a no-op when the channel isn't present in the currently cached ServerDetail (different server / no cache)", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    capturedQueryClient.setQueryData(communityKeys.server("srv_open"), serverDetailFixture("ch_other"))

    expect(() => capturedOnMessage!(unreadBump("ch_random", "u_me"))).not.toThrow()

    const cache = capturedQueryClient.getQueryData<{
      categories: { channels: { id: string; unread: boolean }[] }[]
    }>(communityKeys.server("srv_open"))
    // Untouched — the fixture's own channel stays unread: false.
    expect(cache?.categories[0].channels[0]).toMatchObject({ id: "ch_other", unread: false })
  })

  it("does not crash and is a no-op when no server is currently open", async () => {
    await mountHook({ viewerUserId: "u_me" })
    expect(() => capturedOnMessage!(unreadBump("ch_random", "u_me"))).not.toThrow()
  })

  // ── inbox-dot-ws-driven ② : bump carries serverId / railChannelId / isMention ──

  it("lights the dot on the bump's OWN serverId, even when a DIFFERENT server is open (the cross-server bug)", async () => {
    // The core fix: previously the handler only patched the currently-open
    // server, so a message in another server never lit its dot. With
    // `serverId` on the bump we patch the right server's detail regardless of
    // which one is focused.
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open") // a different server is focused
    capturedQueryClient.setQueryData(communityKeys.server("srv_other"), serverDetailFixture("ch_bg"))

    capturedOnMessage!(unreadBump("ch_bg", "u_me", { serverId: "srv_other" }))

    const cache = capturedQueryClient.getQueryData<{
      categories: { channels: { id: string; unread: boolean }[] }[]
    }>(communityKeys.server("srv_other"))
    expect(cache?.categories[0].channels[0]).toMatchObject({ id: "ch_bg", unread: true })
  })

  it("lights the PARENT channel row for a thread bump (railChannelId), not the thread's own id", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    // The tree row is the parent channel; the thread has no independent row.
    capturedQueryClient.setQueryData(communityKeys.server("srv_open"), serverDetailFixture("ch_parent"))

    // channelId = the thread's id (true scope), railChannelId = parent row.
    capturedOnMessage!(unreadBump("ch_thread", "u_me", { serverId: "srv_open", railChannelId: "ch_parent" }))

    const cache = capturedQueryClient.getQueryData<{
      categories: { channels: { id: string; unread: boolean }[] }[]
    }>(communityKeys.server("srv_open"))
    expect(cache?.categories[0].channels[0]).toMatchObject({ id: "ch_parent", unread: true })
  })

  it("suppresses the dot when the viewer is looking at the RAIL row (thread bump whose parent is open)", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    useCommunityStore.getState().subscribe({ channelId: "ch_parent" }) // parent row is open
    refCounter = 0; stateCounter = 0; callbackCounter = 0
    await mountHook({ viewerUserId: "u_me" })
    capturedQueryClient.setQueryData(communityKeys.server("srv_open"), serverDetailFixture("ch_parent"))

    capturedOnMessage!(unreadBump("ch_thread", "u_me", { serverId: "srv_open", railChannelId: "ch_parent" }))

    const cache = capturedQueryClient.getQueryData<{
      categories: { channels: { id: string; unread: boolean }[] }[]
    }>(communityKeys.server("srv_open"))
    expect(cache?.categories[0].channels[0].unread).toBe(false)
  })

  it("bumps the rail mention badge (servers() mentions +1) ONLY when isMention is set", async () => {
    await mountHook({ viewerUserId: "u_me" })
    capturedQueryClient.setQueryData(communityKeys.servers(), {
      servers: [{ id: "srv_x", name: "X", initial: "X", active: false, mentions: 2, icon: null }],
    })

    // Plain unread (no isMention) → mention count unchanged.
    capturedOnMessage!(unreadBump("ch_a", "u_me", { serverId: "srv_x" }))
    let servers = capturedQueryClient.getQueryData<{ servers: { id: string; mentions: number }[] }>(communityKeys.servers())
    expect(servers?.servers[0].mentions).toBe(2)

    // Mention → +1.
    capturedOnMessage!(unreadBump("ch_a", "u_me", { serverId: "srv_x", isMention: true }))
    servers = capturedQueryClient.getQueryData<{ servers: { id: string; mentions: number }[] }>(communityKeys.servers())
    expect(servers?.servers[0].mentions).toBe(3)
  })

  it("existing focused-channel message patch and debounced inbox invalidation still fire on message.create", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "u_me" })
      const { useCommunityStore } = await import("@/stores/community")
      useCommunityStore.getState().setCurrentServerId("srv_open")
      useCommunityStore.getState().subscribe({ channelId: "ch_focused" })
      refCounter = 0
      stateCounter = 0
      callbackCounter = 0
      await mountHook({ viewerUserId: "u_me" })

      capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_focused"), {
        pages: [{ messages: [], hasMore: false }],
        pageParams: [null],
      })
      capturedQueryClient.setQueryData(communityKeys.server("srv_open"), serverDetailFixture("ch_focused"))
      const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")

      capturedOnMessage!(messageCreate("ch_focused"))
      vi.advanceTimersByTime(500)

      const messagesCache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
        communityKeys.channelMessages("ch_focused"),
      )
      expect(messagesCache?.pages[0].messages).toEqual([])
      expect(getMessageOverlay({ kind: "channel", id: "ch_focused", serverId: "s1" }).liveById.has("m_1")).toBe(true)
      const inboxCalls = invalidateSpy.mock.calls.filter((c) => {
        const key = c[0]?.queryKey
        return Array.isArray(key) && key.includes("inbox")
      })
      expect(inboxCalls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("useCommunityWs — reactions", () => {
  it("patches the message row's reactions in the channel cache", async () => {
    await mountHook({ viewerUserId: "u_me" })
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [
        {
          messages: [
            { id: "m_1", content: "x", reactions: [] },
          ],
          hasMore: false,
        },
      ],
      pageParams: [null],
    })
    const event: CommunityReactionAdd = {
      type: "community:reaction.add",
      channelId: "ch_1",
      messageId: "m_1",
      userId: "u_other",
      emoji: "👍",
    }
    capturedOnMessage!(event)
    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string; reactions: { emoji: string; count: number; me: boolean }[] }[] }[]
    }>(communityKeys.channelMessages("ch_1"))
    expect(cache?.pages[0].messages[0].reactions).toEqual([
      { emoji: "👍", count: 1, me: false, userIds: ["u_other"] },
    ])
  })

  it("refreshes a focused DM row that exists only in the overlay", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
    await mountHook({ viewerUserId: "u_me" })
    useMessageStreamStore.getState().dispatch(
      { kind: "dm", id: "dm_1" },
      {
        type: "wsMessage",
        message: {
          id: "m_dm",
          seq: 4,
          type: "chat",
          authorId: "u_other",
          authorName: "Other",
          content: "hi",
          reactions: [],
        },
      },
    )

    capturedOnMessage!({
      type: "community:reaction.add",
      channelId: "dm_1",
      messageId: "m_dm",
      userId: "u_me",
      emoji: "👍",
    })

    expect(getMessageOverlay({ kind: "dm", id: "dm_1" }).liveById.get("m_dm")?.reactions).toEqual([
      { emoji: "👍", count: 1, me: true, userIds: ["u_me"] },
    ])
  })
})

describe("useCommunityWs — message.updated", () => {
  it("refreshes approval fields on a focused DM row that exists only in the overlay", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
    await mountHook()
    useMessageStreamStore.getState().dispatch(
      { kind: "dm", id: "dm_1" },
      {
        type: "wsMessage",
        message: { id: "m_dm", seq: 4, type: "chat", content: "approval" },
      },
    )
    const profile = { id: "u_other", name: "Other", discriminator: "0001", image: null }
    const approval = {
      friendshipId: "friendship_1",
      status: "approved" as const,
      waitingOn: null,
      otherProfile: profile,
      botProfile: { ...profile, id: "bot_1", name: "Bot" },
    }

    capturedOnMessage!({
      type: "community:message.updated",
      channelId: "dm_1",
      messageId: "m_dm",
      approval,
    })

    expect(getMessageOverlay({ kind: "dm", id: "dm_1" }).liveById.get("m_dm")?.approval).toEqual(approval)
  })
})

describe("useCommunityWs — pin.add", () => {
  it("invalidates the channel's pin list", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event: CommunityPinAdd = {
      type: "community:pin.add",
      channelId: "ch_1",
      messageId: "m_1",
    }
    capturedOnMessage!(event)
    const pinsCalls = spy.mock.calls.filter((c) =>
      JSON.stringify(c[0]?.queryKey ?? []).includes(`"pins"`) ||
      // pins() nests under channel + channelId + pins
      (Array.isArray(c[0]?.queryKey) && (c[0]!.queryKey as unknown[]).includes("pins")),
    )
    // At least one invalidate is against communityKeys.pins("ch_1").
    expect(
      pinsCalls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("ch_1") && key.includes("pins")
      }),
    ).toBe(true)
  })
})

describe("useCommunityWs — member events", () => {
  it("patches the members cache with a join event", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.members("srv_1"), {
      pages: [{ members: [], hasMore: false, limit: 50, total: 0 }],
      pageParams: [null],
    })
    const event: CommunityMemberJoin = {
      type: "community:member.join",
      serverId: "srv_1",
      member: {
        id: "mem_1",
        userId: "u_1",
        name: "n",
        discriminator: "0000",
        role: "member",
        joinedAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)
    const cache = capturedQueryClient.getQueryData<{
      pages: { members: { userId: string }[]; total: number }[]
    }>(communityKeys.members("srv_1"))
    expect(cache?.pages[0].members.map((m) => m.userId)).toEqual(["u_1"])
    expect(cache?.pages[0].total).toBe(1)
  })

  it("a self-rename (member.update with userId + changes.nickname) patches authorName in every cached channel/DM message list", async () => {
    await mountHook()
    useMessageStreamStore.getState().dispatch(
      { kind: "dm", id: "dm_overlay" },
      {
        type: "wsMessage",
        message: {
          id: "m_overlay",
          seq: 9,
          type: "chat",
          authorId: "u_renamed",
          authorName: "OldName",
          content: "overlay only",
        },
      },
    )

    // Two message caches — one channel, one DM — each with a message
    // authored by the renamed user and one by someone else. Both should
    // update; the other author's row must stay untouched.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{
        messages: [
          { id: "m_1", authorId: "u_renamed", authorName: "OldName", content: "hi" },
          { id: "m_2", authorId: "u_other", authorName: "Someone Else", content: "yo" },
        ],
        hasMore: false,
      }],
      pageParams: [null],
    })
    capturedQueryClient.setQueryData(communityKeys.dmMessages("dm_1"), {
      pages: [{
        messages: [
          { id: "m_3", authorId: "u_renamed", authorName: "OldName", content: "sup" },
        ],
        hasMore: false,
      }],
      pageParams: [null],
    })

    const event: CommunityMemberUpdate = {
      type: "community:member.update",
      serverId: "srv_1",
      memberId: "mem_1",
      userId: "u_renamed",
      changes: { nickname: "NewName" },
    }
    capturedOnMessage!(event)

    const channelCache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string; authorName: string }[] }[]
    }>(communityKeys.channelMessages("ch_1"))
    expect(channelCache?.pages[0].messages).toEqual([
      { id: "m_1", authorId: "u_renamed", authorName: "NewName", content: "hi" },
      { id: "m_2", authorId: "u_other", authorName: "Someone Else", content: "yo" },
    ])

    const dmCache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string; authorName: string }[] }[]
    }>(communityKeys.dmMessages("dm_1"))
    expect(dmCache?.pages[0].messages).toEqual([
      { id: "m_3", authorId: "u_renamed", authorName: "NewName", content: "sup" },
    ])
    expect(
      getMessageOverlay({ kind: "dm", id: "dm_overlay" }).liveById.get("m_overlay")?.authorName,
    ).toBe("NewName")
  })

  it("a role-only member.update (no userId/nickname) does not touch any message cache", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{
        messages: [{ id: "m_1", authorId: "u_1", authorName: "Name", content: "hi" }],
        hasMore: false,
      }],
      pageParams: [null],
    })

    const event: CommunityMemberUpdate = {
      type: "community:member.update",
      serverId: "srv_1",
      memberId: "mem_1",
      changes: { role: "admin" },
    }
    capturedOnMessage!(event)

    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string; authorName: string }[] }[]
    }>(communityKeys.channelMessages("ch_1"))
    expect(cache?.pages[0].messages).toEqual([
      { id: "m_1", authorId: "u_1", authorName: "Name", content: "hi" },
    ])
  })
})

describe("useCommunityWs — channel.member_add/remove → invalidate rosters", () => {
  it("member_add invalidates channelMembers AND threadParticipants for a child thread", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!({
      type: "community:channel.member_add",
      serverId: "srv_1",
      channelId: "ch_1",
      userId: "u_new",
    })
    const invalidated = (key: unknown) =>
      spy.mock.calls.some((c) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(key))
    expect(invalidated(communityKeys.channelMembers("ch_1"))).toBe(true)
    expect(invalidated(communityKeys.threadParticipants("ch_1"))).toBe(true)
  })

  it("member_remove invalidates threadParticipants too", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!({
      type: "community:channel.member_remove",
      serverId: "srv_1",
      channelId: "ch_1",
      userId: "u_gone",
    })
    expect(
      spy.mock.calls.some(
        (c) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(communityKeys.threadParticipants("ch_1")),
      ),
    ).toBe(true)
  })
})

describe("useCommunityWs — friend + mention → invalidate", () => {
  it("friend.request invalidates communityKeys.friends()", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event: CommunityFriendRequest = {
      type: "community:friend.request",
      friendship: {
        id: "f_1",
        requesterId: "u_a",
        addresseeId: "u_b",
        status: "pending",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)
    expect(
      spy.mock.calls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("friends")
      }),
    ).toBe(true)
  })

  it("mention.create invalidates communityKeys.inbox() immediately (no debounce)", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event: CommunityMentionCreate = {
      type: "community:mention.create",
      userId: "u_1",
      messageId: "m_1",
      authorName: "A",
    }
    capturedOnMessage!(event)
    expect(
      spy.mock.calls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("inbox")
      }),
    ).toBe(true)
  })

  it("mention.create also invalidates communityKeys.servers() so the rail badge ticks", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event: CommunityMentionCreate = {
      type: "community:mention.create",
      userId: "u_1",
      messageId: "m_1",
      authorName: "A",
    }
    capturedOnMessage!(event)
    const serversInvalidates = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.length === 2 && key[0] === "community" && key[1] === "servers"
    })
    expect(serversInvalidates).toHaveLength(1)
  })
})

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

describe("useCommunityWs — server.update patches server + list caches", () => {
  it("applies name change to server(id) and servers()", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      name: "old",
      description: "d",
      icon: null,
      ownerId: "u_1",
      categories: [],
    })
    capturedQueryClient.setQueryData(communityKeys.servers(), {
      servers: [
        {
          id: "srv_1",
          name: "old",
          initial: "O",
          active: false,
          unread: false,
          mentions: 0,
        },
      ],
    })
    const event: CommunityServerUpdate = {
      type: "community:server.update",
      serverId: "srv_1",
      changes: { name: "new" },
    }
    capturedOnMessage!(event)
    expect(capturedQueryClient.getQueryData<{ name: string }>(communityKeys.server("srv_1"))).toMatchObject({
      name: "new",
    })
    expect(
      capturedQueryClient.getQueryData<{ servers: { name: string; initial: string }[] }>(
        communityKeys.servers(),
      )?.servers[0],
    ).toMatchObject({ name: "new", initial: "N" })
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

describe("useCommunityWs — child channel events", () => {
  it("child_create invalidates threads without a parallel forum cache", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event: CommunityChildChannelCreate = {
      type: "community:channel.child_create",
      parentChannelId: "ch_1",
      channel: {
        id: "ch_thread",
        name: "t",
        type: "thread",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey as unknown[])
    expect(keys.some((k) => k?.includes("threads"))).toBe(true)
    expect(keys.some((k) => k?.includes("forum-threads"))).toBe(false)
  })
})

describe("useCommunityWs — channel.* invalidates server(id)", () => {
  it("channel.create invalidates server(serverId)", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event: CommunityChannelCreate = {
      type: "community:channel.create",
      serverId: "srv_1",
      channel: {
        id: "ch_new",
        name: "n",
        type: "text",
        position: 0,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)
    expect(
      spy.mock.calls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("srv_1")
      }),
    ).toBe(true)
  })
})

describe("useCommunityWs — DM message.create", () => {
  it("writes the focused DM overlay, leaves Query base-only, and invalidates dms()", async () => {
    vi.useFakeTimers()
    try {
      await mountHook()
      const { useCommunityStore } = await import("@/stores/community")
      useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
      refCounter = 0
      stateCounter = 0
      callbackCounter = 0
      await mountHook()

      capturedQueryClient.setQueryData(communityKeys.dmMessages("dm_1"), {
        pages: [{ messages: [], hasMore: false }],
        pageParams: [null],
      })
      const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
      // A DM is a channel now — its message arrives as `message.create` keyed by
      // the DM's channel id (which the subscription tracks in `dmConversationId`).
      const event: CommunityMessageCreate = {
        type: "community:message.create",
        channelId: "dm_1",
        message: {
          id: "dm_m_1",
          seq: 1,
          authorId: "u_a",
          authorName: "a",
          content: "hi",
          type: "chat",
          createdAt: "2026-07-03T00:00:00.000Z",
        },
      }
      capturedOnMessage!(event)
      const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
        communityKeys.dmMessages("dm_1"),
      )
      expect(cache?.pages[0].messages).toEqual([])
      const { getMessageOverlay } = await import("@/stores/community/message-stream")
      expect(
        [...getMessageOverlay({ kind: "dm", id: "dm_1" }).liveById.values()].map((message) => message.id),
      ).toEqual(["dm_m_1"])
      // The inbox + `dms()` invalidation is batched behind the inbox debounce.
      vi.advanceTimersByTime(600)
      expect(
        spy.mock.calls.some((c) => {
          const key = c[0]?.queryKey as unknown[] | undefined
          return Array.isArray(key) && key.includes("dms")
        }),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("heals an already-seen DM event into the overlay before seen dedupe returns", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
    useCommunityWsStore.getState().markSeenMessage("dm_replay")
    await mountHook()

    capturedOnMessage!({
      type: "community:message.create",
      channelId: "dm_1",
      message: {
        id: "dm_replay",
        seq: 12,
        authorId: "u_a",
        authorName: "a",
        content: "replay",
        type: "chat",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    })

    expect(getMessageOverlay({ kind: "dm", id: "dm_1" }).liveById.has("dm_replay")).toBe(true)
  })
})

describe("useCommunityWs — non-community events bail", () => {
  it("malformed shape early-returns via isCommunityEvent", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "setQueryData")
    capturedOnMessage!({ type: "task.updated", taskId: "t_1" })
    expect(spy).not.toHaveBeenCalled()
  })
})

// ── Regression #3 — channel.delete evicts channel-scoped caches ─────────
describe("useCommunityWs — channel.delete evicts channel-scoped caches", () => {
  it("removes channelMessages, pins, and threads for the deleted channel", async () => {
    await mountHook()
    // Seed every canonical cache for the target channel so we can observe eviction.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_dead"), {
      pages: [{ messages: [{ id: "m_1" }], hasMore: false }],
      pageParams: [null],
    })
    capturedQueryClient.setQueryData(communityKeys.pins("ch_dead"), { pins: [{ id: "p" }] })
    capturedQueryClient.setQueryData(communityKeys.threads("ch_dead"), { threads: [{ id: "t" }] })

    const event: CommunityChannelDelete = {
      type: "community:channel.delete",
      serverId: "srv_1",
      channelId: "ch_dead",
    }
    capturedOnMessage!(event)

    expect(capturedQueryClient.getQueryData(communityKeys.channelMessages("ch_dead"))).toBeUndefined()
    expect(capturedQueryClient.getQueryData(communityKeys.pins("ch_dead"))).toBeUndefined()
    expect(capturedQueryClient.getQueryData(communityKeys.threads("ch_dead"))).toBeUndefined()
  })
})

// ── Regression #4 — child_create seeds messageCount: 0 ──────────────────
describe("useCommunityWs — child_create patches parent thread badge with count 0", () => {
  it("stamps messageCount: 0 on the parent message's thread stub", async () => {
    await mountHook()
    // Seed the parent channel's messages cache with the parent message.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_parent"), {
      pages: [
        {
          messages: [{ id: "m_parent", content: "hello" }],
          hasMore: false,
        },
      ],
      pageParams: [null],
    })

    const event: CommunityChildChannelCreate = {
      type: "community:channel.child_create",
      parentChannelId: "ch_parent",
      parentMessageId: "m_parent",
      channel: {
        id: "ch_thread",
        name: "New thread",
        type: "thread",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)

    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string; thread?: { id: string; name: string; messageCount: number } }[] }[]
    }>(communityKeys.channelMessages("ch_parent"))
    expect(cache?.pages[0].messages[0].thread).toEqual({
      id: "ch_thread",
      name: "New thread",
      messageCount: 0,
    })
  })

  it("child_update still applies the reported messageCount unchanged", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_parent"), {
      pages: [
        {
          messages: [
            {
              id: "m_parent",
              content: "hello",
              thread: { id: "ch_thread", name: "old", messageCount: 0 },
            },
          ],
          hasMore: false,
        },
      ],
      pageParams: [null],
    })

    const event: CommunityChildChannelUpdate = {
      type: "community:channel.child_update",
      parentChannelId: "ch_parent",
      channelId: "ch_thread",
      changes: { messageCount: 5 },
    }
    capturedOnMessage!(event)

    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: { thread?: { messageCount: number } }[] }[]
    }>(communityKeys.channelMessages("ch_parent"))
    expect(cache?.pages[0].messages[0].thread?.messageCount).toBe(5)
  })

  it("child_update keeps newer thread fields from the current base row when refreshing fallback", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("s1")
    const scope = { kind: "channel" as const, id: "ch_parent", serverId: "s1" }
    useMessageStreamStore.getState().dispatch(scope, {
      type: "wsMessage",
      message: {
        id: "m_parent",
        seq: 1,
        type: "chat",
        authorId: "u1",
        authorName: "Alice",
        content: "hello",
        createdAt: "2026-08-06T00:00:00.000Z",
        thread: {
          id: "ch_thread",
          name: "fallback",
          messageCount: 1,
          lastReplyAt: "2026-08-06T00:00:01.000Z",
        },
      },
    })
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_parent"), {
      pages: [{
        messages: [{
          id: "m_parent",
          seq: 1,
          type: "chat",
          authorId: "u1",
          authorName: "Alice",
          content: "hello",
          createdAt: "2026-08-06T00:00:00.000Z",
          thread: {
            id: "ch_thread",
            name: "base",
            messageCount: 2,
            lastReplyAt: "2026-08-06T00:00:02.000Z",
          },
        }],
        hasMore: false,
      }],
      pageParams: [null],
    })

    capturedOnMessage!({
      type: "community:channel.child_update",
      parentChannelId: "ch_parent",
      channelId: "ch_thread",
      changes: { messageCount: 5 },
    } satisfies CommunityChildChannelUpdate)

    expect(getMessageOverlay(scope).liveById.get("m_parent")?.thread).toEqual({
      id: "ch_thread",
      name: "base",
      messageCount: 5,
      lastReplyAt: "2026-08-06T00:00:02.000Z",
    })
  })
})

// ── Regression #5 — typing.start focus guard (DM leak) ──────────────────
describe("useCommunityWs — typing.start honours focus (no DM leak)", () => {
  it("does NOT surface a DM-only typing.start when the viewer is focused on a channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    const event: CommunityTypingStart = {
      type: "community:typing.start",
      channelId: "dm_other",
      userId: "u_other",
    }
    capturedOnMessage!(event)

    // Focus is on ch_1, so the unfocused DM channel's typing.start is dropped
    // entirely — no scope gains a typer.
    const state = useCommunityStore.getState()
    expect(state.typingByScope.get("dm:dm_other")).toBeUndefined()
    expect(state.typingByScope.get("ch:dm_other")).toBeUndefined()
    expect(state.typingByScope.get("ch:ch_1")).toBeUndefined()
  })

  it("does surface a channel typing.start when the viewer is focused on that channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    const event: CommunityTypingStart = {
      type: "community:typing.start",
      channelId: "ch_1",
      userId: "u_other",
    }
    capturedOnMessage!(event)

    expect([...(useCommunityStore.getState().typingByScope.get("ch:ch_1")?.keys() ?? [])]).toEqual([
      "u_other",
    ])
  })

  it("stores the name the typing event carries (fixes 'Unknown member' when the typer isn't in the loaded roster)", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    const event: CommunityTypingStart = {
      type: "community:typing.start",
      channelId: "ch_1",
      userId: "u_other",
      name: "Alice",
      discriminator: "0001",
    }
    capturedOnMessage!(event)

    // The name rides the event → the consumer renders it directly, no roster
    // lookup, so a typer outside the loaded roster page is no longer "Unknown".
    expect(useCommunityStore.getState().typingByScope.get("ch:ch_1")?.get("u_other")).toBe("Alice")
  })

  it("stores null when the typing event carries no name (older server → consumer falls back to roster)", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook()

    capturedOnMessage!({
      type: "community:typing.start",
      channelId: "ch_1",
      userId: "u_other",
    } as CommunityTypingStart)

    expect(useCommunityStore.getState().typingByScope.get("ch:ch_1")?.get("u_other")).toBeNull()
  })
})

// ── Typing scope isolation (per-conversation, no cross-leak) ────────────────
describe("useCommunityWs — typing state is scoped per conversation", () => {
  it("a DM typer lands only in the DM scope, never in a channel scope", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    // Viewer is focused on the DM when the peer starts typing.
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook({ viewerUserId: "u_me" })

    // A DM is a channel — typing arrives as `typing.start` keyed by the DM's
    // channel id. The scope key resolves to `dm:` because the subscription's
    // `dmConversationId` slot holds that channel id.
    capturedOnMessage!({
      type: "community:typing.start",
      channelId: "dm_1",
      userId: "u_peer",
    })

    const state = useCommunityStore.getState()
    // The typer is confined to dm:dm_1 — a channel view reading ch:* sees nothing.
    expect([...(state.typingByScope.get("dm:dm_1")?.keys() ?? [])]).toEqual(["u_peer"])
    expect(state.typingByScope.get("ch:dm_1")).toBeUndefined()
    // The 8s timer is keyed by (scope, user), not user alone.
    expect(state.typingTimers.has("dm:dm_1|u_peer")).toBe(true)
  })

  it("bot DM reply (message.create on a DM channel) clears the DM pill, in the dm: scope", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_bot" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook({ viewerUserId: "u_me" })

    // Bot is "typing" in the DM (typing.start on the DM channel).
    capturedOnMessage!({
      type: "community:typing.start",
      channelId: "dm_bot",
      userId: "u_bot",
    })
    expect([...(useCommunityStore.getState().typingByScope.get("dm:dm_bot")?.keys() ?? [])]).toEqual([
      "u_bot",
    ])

    // Its reply arrives as message.create on the same DM channel. The scope key
    // must resolve to dm:dm_bot (via the subscription), clearing the pill — not
    // leak into a ch: bucket.
    capturedOnMessage!({
      type: "community:message.create",
      channelId: "dm_bot",
      message: {
        id: "m_bot_reply",
        authorId: "u_bot",
        authorName: "bot",
        content: "done",
        type: "chat",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    } as CommunityMessageCreate)

    const state = useCommunityStore.getState()
    expect(state.typingByScope.get("dm:dm_bot")).toBeUndefined()
    expect(state.typingByScope.get("ch:dm_bot")).toBeUndefined()
    expect(state.typingTimers.has("dm:dm_bot|u_bot")).toBe(false)
  })
})

// ── channel.delete invalidates the parent forum list (post deletion) ────────
describe("useCommunityWs — channel.delete refreshes the parent forum feed", () => {
  it("invalidates the parent's message feed + threads list when parentChannelId is present", async () => {
    await mountHook()
    const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    const event: CommunityChannelDelete = {
      type: "community:channel.delete",
      serverId: "srv_1",
      channelId: "post_1",
      parentChannelId: "forum_1",
    }
    capturedOnMessage!(event)

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
    expect(invalidatedKeys).toContain(JSON.stringify(communityKeys.channelMessages("forum_1")))
    expect(invalidatedKeys).toContain(JSON.stringify(communityKeys.threads("forum_1")))
  })

  it("does not throw and still evicts own caches when parentChannelId is absent (legacy event)", async () => {
    await mountHook()
    // Seed the deleted channel's own message cache so we can assert eviction.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("post_1"), { pages: [], pageParams: [] })
    const removeSpy = vi.spyOn(capturedQueryClient, "removeQueries")

    const event: CommunityChannelDelete = {
      type: "community:channel.delete",
      serverId: "srv_1",
      channelId: "post_1",
    }
    expect(() => capturedOnMessage!(event)).not.toThrow()

    const removedKeys = removeSpy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
    expect(removedKeys).toContain(JSON.stringify(communityKeys.channelMessages("post_1")))
  })
})

describe("useCommunityWs — message edit refreshes forum opener summary", () => {
  it("invalidates the parent thread list for an opener edit, but not for an ordinary reply", async () => {
    await mountHook()
    const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const opener: CommunityMessageEdited = {
      type: "community:message.edited",
      channelId: "post_1",
      messageId: "opener_1",
      content: "new title",
      parentChannelId: "forum_1",
    }
    capturedQueryClient.setQueryData(communityKeys.message("opener_1"), {
      id: "opener_1",
      content: "old title",
    })
    capturedQueryClient.setQueryData(communityKeys.channelMessages("forum_1"), { pages: [], pageParams: [] })
    capturedQueryClient.setQueryData([...communityKeys.channelMessages("forum_1"), "tag", "bug"], { pages: [], pageParams: [] })
    capturedOnMessage!(opener)
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: communityKeys.channelMessages("forum_1") })
    expect(capturedQueryClient.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(true)
    expect(capturedQueryClient.getQueryState([...communityKeys.channelMessages("forum_1"), "tag", "bug"])?.isInvalidated).toBe(true)
    expect(capturedQueryClient.getQueryData<{ content: string }>(communityKeys.message("opener_1"))?.content).toBe("new title")

    invalidateSpy.mockClear()
    capturedOnMessage!({
      type: "community:message.edited",
      channelId: "post_1",
      messageId: "reply_1",
      content: "edited reply",
    } satisfies CommunityMessageEdited)
    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})

// ── #3 — WS message.create MUST NOT auto-mark-read ─────────────────────────
// The IntersectionObserver in `useChannelWatermark` is authoritative: the
// read pointer only advances when a message actually becomes visible in the
// viewport. If the user is scrolled up reading history, a WS-delivered new
// message must NOT touch the pointer — that's the whole point of the fix.
describe("useCommunityWs — does NOT auto-mark-read on WS message.create", () => {
  it("does NOT call markRead when a foreign-authored message lands in the focused channel", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_focused" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook({ viewerUserId: "u_me" })

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_focused"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })

    const event: CommunityMessageCreate = {
      type: "community:message.create",
      channelId: "ch_focused",
      message: {
        id: "m_1",
        authorId: "u_someone_else",
        authorName: "them",
        content: "hi",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)

    expect(markReadMutate).not.toHaveBeenCalled()
  })

  it("does NOT call markRead when the message is authored by the viewer", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_focused" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook({ viewerUserId: "u_me" })

    const event: CommunityMessageCreate = {
      type: "community:message.create",
      channelId: "ch_focused",
      message: {
        id: "m_1",
        authorId: "u_me",
        authorName: "me",
        content: "hi",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)

    expect(markReadMutate).not.toHaveBeenCalled()
  })

  it("does NOT call markRead for a DM message.create either", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook({ viewerUserId: "u_me" })

    const event: CommunityMessageCreate = {
      type: "community:message.create",
      channelId: "dm_1",
      message: {
        id: "dm_m_1",
        authorId: "u_a",
        authorName: "a",
        content: "hi",
        type: "chat",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)

    expect(markReadMutate).not.toHaveBeenCalled()
  })
})

// ── Regression #8 — server.update explicit-null icon clears the field ───
describe("useCommunityWs — server.update icon removal", () => {
  it("clears icon when changes.icon is null (does not fall back to the prior icon)", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      name: "n",
      description: "d",
      icon: "https://cdn/x.png",
      ownerId: "u_1",
      categories: [],
    })
    const event: CommunityServerUpdate = {
      type: "community:server.update",
      serverId: "srv_1",
      changes: { icon: null },
    }
    capturedOnMessage!(event)
    const detail = capturedQueryClient.getQueryData<{ icon: string | null }>(
      communityKeys.server("srv_1"),
    )
    expect(detail?.icon).toBeNull()
  })
})

// ── Regression #10 — server.delete resets focused-server pointers ───────
describe("useCommunityWs — server.delete resets store when focused server dies", () => {
  it("clears currentServerId + currentChannelId if the deleted server is currently focused", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_doomed")
    useCommunityStore.getState().setCurrentChannelId("ch_1")

    const event: CommunityServerDelete = {
      type: "community:server.delete",
      serverId: "srv_doomed",
    }
    capturedOnMessage!(event)

    expect(useCommunityStore.getState().currentServerId).toBeNull()
    expect(useCommunityStore.getState().currentChannelId).toBeNull()
  })

  it("does NOT touch the store when a different server is deleted", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_active")
    useCommunityStore.getState().setCurrentChannelId("ch_1")

    const event: CommunityServerDelete = {
      type: "community:server.delete",
      serverId: "srv_other",
    }
    capturedOnMessage!(event)

    expect(useCommunityStore.getState().currentServerId).toBe("srv_active")
    expect(useCommunityStore.getState().currentChannelId).toBe("ch_1")
  })
})

// ── "stuck offline" fix — resync machines on WS reconnect ───────────────
describe("useCommunityWs — resyncs machines on WS reconnect", () => {
  it("invalidates communityKeys.machines() when the captured onReconnect fires", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    capturedOnReconnect!()

    expect(
      spy.mock.calls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("machines")
      }),
    ).toBe(true)
  })

  it("invalidates the focused channel's messages + inbox on reconnect, but NOT the read-state snapshot", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_focus" })

    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    capturedOnReconnect!()

    const invalidatedKeys = spy.mock.calls.map(
      (c) => c[0]?.queryKey as unknown[] | undefined,
    )
    // Focused channel messages — a legitimate top-up refetch that keeps data.
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "channel" &&
          k[2] === "ch_focus" &&
          k[3] === "messages",
      ),
    ).toBe(true)
    // Read-state snapshot MUST NOT be invalidated: the snapshot hook latches
    // its first value (gcTime: 0, frozen ref) so a refetch can't move the
    // "New" divider — it only flips `isFetching` back to true, which the
    // channel page reads as loading and flashes a second skeleton mid-mount
    // (the "skeleton → content → skeleton → top hero" refresh bug). See
    // `handleReconnect`'s comment in use-community-ws.ts.
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "channel" &&
          k[2] === "ch_focus" &&
          k[3] === "read-state-snapshot",
      ),
    ).toBe(false)
    // Inbox
    expect(
      invalidatedKeys.some(
        (k) => Array.isArray(k) && k[0] === "community" && k[1] === "inbox",
      ),
    ).toBe(true)
  })

  it("re-seeds the rail list + open server's detail on reconnect (inbox-dot-ws-driven ②)", async () => {
    // Sidebar dots + rail mention badges are now driven by the live
    // `unread.bump` patch, with no switch-refetch backing them. A bump dropped
    // during the socket gap would leave them stale, so reconnect must re-seed
    // both — else the cross-server dot fix silently rots after any disconnect.
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_open")
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    // handleReconnect reads currentServerId via getState() at call time.
    expect(capturedOnReconnect).not.toBeNull()
    capturedOnReconnect!()

    const invalidatedKeys = spy.mock.calls.map(
      (c) => c[0]?.queryKey as unknown[] | undefined,
    )
    // Rail LIST = communityKeys.servers() = ["community","servers"] (length 2).
    expect(
      invalidatedKeys.some(
        (k) => Array.isArray(k) && k.length === 2 && k[0] === "community" && k[1] === "servers",
      ),
    ).toBe(true)
    // Open server's DETAIL = communityKeys.server(id) = ["community","servers",id].
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "servers" &&
          k[2] === "srv_open",
      ),
    ).toBe(true)
  })

  it("invalidates the focused DM's messages on reconnect, but NOT its read-state snapshot", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_focus" })

    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    capturedOnReconnect!()

    const invalidatedKeys = spy.mock.calls.map(
      (c) => c[0]?.queryKey as unknown[] | undefined,
    )
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "dm" &&
          k[2] === "dm_focus" &&
          k[3] === "messages",
      ),
    ).toBe(true)
    // Read-state snapshot MUST NOT be invalidated — same rationale as the
    // channel case (mirrors `useChannelReadStateSnapshot`'s freeze contract).
    expect(
      invalidatedKeys.some(
        (k) =>
          Array.isArray(k) &&
          k[0] === "community" &&
          k[1] === "dm" &&
          k[2] === "dm_focus" &&
          k[3] === "read-state-snapshot",
      ),
    ).toBe(false)
  })

  it("only invalidates the focused scope — no channel invalidation when only a DM is focused", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_focus" })

    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    expect(capturedOnReconnect).not.toBeNull()
    capturedOnReconnect!()

    const invalidatedKeys = spy.mock.calls.map(
      (c) => c[0]?.queryKey as unknown[] | undefined,
    )
    // No channel-scoped message invalidation should have fired.
    expect(
      invalidatedKeys.some(
        (k) => Array.isArray(k) && k[1] === "channel" && k[3] === "messages",
      ),
    ).toBe(false)
  })
})

// ── Regression #15 — double-mount guard warns ───────────────────────────
describe("useCommunityWs — double-mount detection", () => {
  it("emits console.warn when a second instance mounts with a different send", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { })
    try {
      // First mount publishes the current stable `send` into activeSend.
      await mountHook()
      flushEffects()
      // Simulate a second, independent hook site returning a different `send`
      // by swapping the shared stub before the second mount.
      stableSend = vi.fn()
      // Reset ref counters so the shim hands out fresh refs (mimics a second
      // hook site — not a re-render of the first).
      refs = new Map()
      refCounter = 0
      callbackMemo = new Map()
      callbackCounter = 0
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
      refs = new Map()
      refCounter = 0
      callbackMemo = new Map()
      callbackCounter = 0
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
