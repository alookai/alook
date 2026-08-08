import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CommunityFriendRequest,
  CommunityMentionCreate,
  CommunityMessageCreate,
} from "@alook/shared"
import { getMessageOverlay } from "@/stores/community/message-stream"
import { communityKeys } from "@/lib/query-keys"
import type { ServerDetail } from "../use-servers"
import {
  patchForumSidebarUnread,
  reconcileForumSidebarUnreadFallbacks,
  type ForumSidebarQueryData,
  type ForumSidebarUnreadFallbackState,
} from "../use-forum-sidebar-threads"
import {
  capturedOnMessage,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  forumSidebarFixture,
  messageCreate,
  mountHook,
  resetCommunityWsHarness,
  resetHookMemoization,
  unreadBump,
} from "./test-harness"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

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

  it("routes a child unread.bump to its loaded forum-sidebar row instead of the parent forum", async () => {
    await mountHook({ viewerUserId: "u_me" })
    capturedQueryClient.setQueryData(communityKeys.server("srv_open"), serverDetailFixture("forum_1"))
    const sidebarKey = communityKeys.forumSidebarThreadsView("srv_open", null)
    capturedQueryClient.setQueryData(sidebarKey, forumSidebarFixture())

    capturedOnMessage!(unreadBump("post_1", "u_me", {
      serverId: "srv_open",
      railChannelId: "forum_1",
    }))

    expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(sidebarKey)?.threads[0].unread)
      .toBe(true)
    expect(capturedQueryClient.getQueryData<ReturnType<typeof serverDetailFixture>>(
      communityKeys.server("srv_open"),
    )?.categories[0].channels[0].unread).toBe(false)
    expect(capturedQueryClient.getQueryData<ServerDetail>(
      communityKeys.server("srv_open"),
    )?.forumUnreadState?.forum_1?.childIds).toEqual(["post_1"])
  })

  it("falls back to the parent forum dot when the child has no locatable sidebar row", async () => {
    await mountHook({ viewerUserId: "u_me" })
    capturedQueryClient.setQueryData(communityKeys.server("srv_open"), serverDetailFixture("forum_1"))
    capturedQueryClient.setQueryData(
      communityKeys.forumSidebarThreadsView("srv_open", null),
      forumSidebarFixture([]),
    )

    capturedOnMessage!(unreadBump("post_missing", "u_me", {
      serverId: "srv_open",
      railChannelId: "forum_1",
    }))

    expect(capturedQueryClient.getQueryData<ReturnType<typeof serverDetailFixture>>(
      communityKeys.server("srv_open"),
    )?.categories[0].channels[0].unread).toBe(true)
    expect(capturedQueryClient.getQueryData<ForumSidebarUnreadFallbackState>(
      communityKeys.forumSidebarUnreadFallbacks("srv_open"),
    )).toEqual({
      forum_1: { baseUnread: false, childIds: ["post_missing"] },
    })
  })

  it("moves message.create → unread.bump fallback ownership to the refetched child", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const serverKey = communityKeys.server("srv_open")
    const sidebarKey = communityKeys.forumSidebarThreadsView("srv_open", null)
    capturedQueryClient.setQueryData(serverKey, serverDetailFixture("forum_1"))
    capturedQueryClient.setQueryData(sidebarKey, forumSidebarFixture([]))

    capturedOnMessage!({
      ...messageCreate("post_new"),
      serverId: "srv_open",
      parentChannelId: "forum_1",
    } satisfies CommunityMessageCreate)
    expect(capturedQueryClient.getQueryState(sidebarKey)?.isInvalidated).toBe(true)

    capturedOnMessage!(unreadBump("post_new", "u_me", {
      serverId: "srv_open",
      railChannelId: "forum_1",
    }))
    expect(capturedQueryClient.getQueryData<ReturnType<typeof serverDetailFixture>>(
      serverKey,
    )?.categories[0].channels[0].unread).toBe(true)

    const refetched = forumSidebarFixture(["post_new"])
    refetched.threads[0]!.unread = true
    capturedQueryClient.setQueryData(sidebarKey, refetched)
    reconcileForumSidebarUnreadFallbacks(capturedQueryClient, "srv_open", ["post_new"])

    expect(capturedQueryClient.getQueryData<ForumSidebarQueryData>(sidebarKey)?.threads[0]?.unread).toBe(true)
    expect(capturedQueryClient.getQueryData<ReturnType<typeof serverDetailFixture>>(
      serverKey,
    )?.categories[0].channels[0].unread).toBe(false)

    capturedQueryClient.setQueryData<ForumSidebarQueryData>(sidebarKey, (data) =>
      patchForumSidebarUnread(data, "post_new", false),
    )
    expect(capturedQueryClient.getQueryData<ForumSidebarQueryData>(sidebarKey)?.threads[0]?.unread).toBe(false)
    expect(capturedQueryClient.getQueryData<ReturnType<typeof serverDetailFixture>>(
      serverKey,
    )?.categories[0].channels[0].unread).toBe(false)
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
    resetHookMemoization()
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
    resetHookMemoization()
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
      resetHookMemoization()
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
