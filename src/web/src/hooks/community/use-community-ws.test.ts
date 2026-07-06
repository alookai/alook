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
  CommunityReactionAdd,
  CommunityMemberJoin,
  CommunityMachineCreated,
  CommunityMachineStatus,
  CommunityPresenceUpdate,
  CommunityMentionCreate,
  CommunityDmNewMessage,
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
  useState: (initial: unknown) => [initial, () => {}],
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
let stableSend: ReturnType<typeof vi.fn> = vi.fn()
vi.mock("@/lib/use-user-ws", () => ({
  useUserWs: (onMessage: (msg: unknown) => void) => {
    capturedOnMessage = onMessage
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
  flushPendingReads: () => {},
}))

function resetHarness() {
  refs = new Map()
  refCounter = 0
  stateCounter = 0
  callbackMemo = new Map()
  callbackCounter = 0
  pendingEffects = []
  capturedOnMessage = null
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
  const { useCommunityWsStore } = await import("@/stores/community/ws")
  useCommunityWsStore.getState().reset()
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
      authorId: "u_author",
      authorName: "author",
      content: "hi",
      createdAt: "2026-07-03T00:00:00.000Z",
    },
  }
}

describe("useCommunityWs — message.create", () => {
  it("patches channelMessages cache when the event matches the focused channel", async () => {
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
    expect(cache?.pages[0].messages.map((m) => m.id)).toEqual(["m_1"])
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
    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toHaveLength(1)
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
  it("child_create invalidates threads + forumPosts", async () => {
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
    expect(keys.some((k) => k?.includes("posts"))).toBe(true)
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

describe("useCommunityWs — DM new_message", () => {
  it("patches dmMessages cache when focused + invalidates dms()", async () => {
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
    const event: CommunityDmNewMessage = {
      type: "community:dm.new_message",
      dmConversationId: "dm_1",
      message: {
        id: "dm_m_1",
        authorId: "u_a",
        authorName: "a",
        content: "hi",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)
    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.dmMessages("dm_1"),
    )
    expect(cache?.pages[0].messages).toHaveLength(1)
    expect(
      spy.mock.calls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("dms")
      }),
    ).toBe(true)
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
  it("removes channelMessages, pins, threads, and forumPosts for the deleted channel", async () => {
    await mountHook()
    // Seed all four caches for the target channel so we can observe eviction.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_dead"), {
      pages: [{ messages: [{ id: "m_1" }], hasMore: false }],
      pageParams: [null],
    })
    capturedQueryClient.setQueryData(communityKeys.pins("ch_dead"), { pins: [{ id: "p" }] })
    capturedQueryClient.setQueryData(communityKeys.threads("ch_dead"), { threads: [{ id: "t" }] })
    capturedQueryClient.setQueryData(communityKeys.forumPosts("ch_dead"), { posts: [{ id: "fp" }] })

    const event: CommunityChannelDelete = {
      type: "community:channel.delete",
      serverId: "srv_1",
      channelId: "ch_dead",
    }
    capturedOnMessage!(event)

    expect(capturedQueryClient.getQueryData(communityKeys.channelMessages("ch_dead"))).toBeUndefined()
    expect(capturedQueryClient.getQueryData(communityKeys.pins("ch_dead"))).toBeUndefined()
    expect(capturedQueryClient.getQueryData(communityKeys.threads("ch_dead"))).toBeUndefined()
    expect(capturedQueryClient.getQueryData(communityKeys.forumPosts("ch_dead"))).toBeUndefined()
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
      dmConversationId: "dm_other",
      userId: "u_other",
    }
    capturedOnMessage!(event)

    expect(useCommunityStore.getState().typingUsers).toEqual([])
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

    expect(useCommunityStore.getState().typingUsers).toEqual(["u_other"])
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

  it("does NOT call markRead for a DM new_message either", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
    refCounter = 0
    stateCounter = 0
    callbackCounter = 0
    await mountHook({ viewerUserId: "u_me" })

    const event: CommunityDmNewMessage = {
      type: "community:dm.new_message",
      dmConversationId: "dm_1",
      message: {
        id: "dm_m_1",
        authorId: "u_a",
        authorName: "a",
        content: "hi",
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

// ── Regression #15 — double-mount guard warns ───────────────────────────
describe("useCommunityWs — double-mount detection", () => {
  it("emits console.warn when a second instance mounts with a different send", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
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
