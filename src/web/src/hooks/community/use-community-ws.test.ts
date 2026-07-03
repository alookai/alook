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
  CommunityChannelCreate,
  CommunityChildChannelCreate,
  CommunityPinAdd,
  CommunityFriendRequest,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"

// ── React shim ───────────────────────────────────────────────────────────
let refs: Map<string, { current: unknown }> = new Map()
let refCounter = 0
let stateCounter = 0
let callbackMemo: Map<string, { fn: Function; deps: unknown[] }> = new Map()
let callbackCounter = 0

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
  useEffect: (_fn: () => void, _deps: unknown[]) => {},
}))

// Shared QueryClient instance the hook resolves via useQueryClient.
let capturedQueryClient: QueryClient
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQueryClient,
  }
})

// Capture the callback passed into useUserWs so tests can drive it.
let capturedOnMessage: ((msg: unknown) => void) | null = null
vi.mock("@/lib/use-user-ws", () => ({
  useUserWs: (onMessage: (msg: unknown) => void) => {
    capturedOnMessage = onMessage
    return { send: vi.fn() }
  },
}))

function resetHarness() {
  refs = new Map()
  refCounter = 0
  stateCounter = 0
  callbackMemo = new Map()
  callbackCounter = 0
  capturedOnMessage = null
  capturedQueryClient = new QueryClient()
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
