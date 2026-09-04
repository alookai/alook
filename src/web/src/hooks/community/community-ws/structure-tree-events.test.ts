import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryObserver } from "@tanstack/react-query"
import type {
  CommunityCategoryCreate,
  CommunityChannelCreate,
  CommunityChannelDelete,
  CommunityChildChannelCreate,
  CommunityChildChannelUpdate,
  CommunityServerDelete,
  CommunityServerUpdate,
} from "@alook/shared"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import { communityKeys } from "@/lib/query-keys"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import {
  capturedOnMessage,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  forumSidebarFixture,
  messageCreate,
  mountHook,
  resetCommunityWsHarness,
  resetHookMemoization,
} from "./test-harness"

function forumFeedFixture(rows: Array<{ id: string; opener: string; tags: string[] }>) {
  return {
    pages: [{
      serverId: "s1",
      parentType: "forum",
      threads: rows.map((row) => ({
        id: row.id,
        name: row.id,
        creatorId: `author_${row.id}`,
        messageCount: 1,
        parentMessageId: row.opener,
        lastMessageAt: "2026-09-05T00:00:00.000Z",
        createdAt: "2026-09-05T00:00:00.000Z",
        activityAt: "2026-09-05T00:00:00.000Z",
      })),
      included: {
        parentMessages: rows.map((row, index) => ({
          id: row.opener,
          channelId: "forum_1",
          seq: index + 1,
          content: row.id,
          authorId: `author_${row.id}`,
          authorName: row.id,
          authorImage: null,
          authorAvatarVersion: 0,
        })),
        firstMessages: rows.map((row) => ({
          channelId: row.id,
          content: `body ${row.id}`,
        })),
        tags: rows.flatMap((row) => row.tags.map((tag) => ({
          messageId: row.opener,
          tag,
        }))),
        participants: rows.map((row) => ({
          channelId: row.id,
          userId: `author_${row.id}`,
          userName: row.id,
          userImage: null,
          userAvatarVersion: 0,
        })),
      },
      hasMore: false,
    }],
    pageParams: [null],
  }
}

function forumFeedIds(filter: string | null) {
  return capturedQueryClient.getQueryData<ReturnType<typeof forumFeedFixture>>(
    communityKeys.forumFeed("forum_1", filter),
  )?.pages.flatMap((page) => page.threads.map((thread) => thread.id)) ?? []
}

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — server.update patches server + list caches", () => {
  it("applies name and description changes to server(id) and servers()", async () => {
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
          description: "old description",
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
      changes: { name: "new", description: "new description" },
    }
    capturedOnMessage!(event)
    expect(capturedQueryClient.getQueryData<{ name: string; description: string }>(
      communityKeys.server("srv_1"),
    )).toMatchObject({
      name: "new",
      description: "new description",
    })
    expect(
      capturedQueryClient.getQueryData<{
        servers: { name: string; description: string; initial: string }[]
      }>(
        communityKeys.servers(),
      )?.servers[0],
    ).toMatchObject({ name: "new", description: "new description", initial: "N" })
  })
})
describe("useCommunityWs — child channel events", () => {
  it("child_create without a parentMessageId only invalidates threads", async () => {
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
    expect(keys).not.toContainEqual(communityKeys.channelMessages("ch_1"))
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

describe("useCommunityWs — category.* invalidates tree projections", () => {
  it("category.create invalidates the channel directory and matching server", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")

    capturedOnMessage!({
      type: "community:category.create",
      serverId: "srv_1",
      category: {
        id: "cat_new",
        name: "Category",
        position: 0,
        private: false,
      },
    } satisfies CommunityCategoryCreate)

    expect(spy).toHaveBeenCalledWith({
      queryKey: communityKeys.channelRefDirectory(),
      exact: true,
    })
    expect(spy).toHaveBeenCalledWith({
      queryKey: communityKeys.server("srv_1"),
      exact: true,
    })
  })
})

describe("useCommunityWs — invite.create", () => {
  it("invalidates only the matching server invite query", async () => {
    await mountHook()
    const matchingKey = communityKeys.invites("srv_1")
    const otherKey = communityKeys.invites("srv_2")
    capturedQueryClient.setQueryData(matchingKey, { invites: [] })
    capturedQueryClient.setQueryData(otherKey, { invites: [] })

    capturedOnMessage!({
      type: "community:invite.create",
      serverId: "srv_1",
      invite: {
        id: "invite_1",
        token: "token_1",
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    })

    expect(capturedQueryClient.getQueryState(matchingKey)?.isInvalidated).toBe(true)
    expect(capturedQueryClient.getQueryState(otherKey)?.isInvalidated).toBe(false)
  })
})

describe("useCommunityWs — channel.delete evicts channel-scoped caches", () => {
  it("fences a deleted channel's cached raw Inbox row", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const unreadProjection = getAccountUnreadProjection(capturedQueryClient, "u_me")
    unreadProjection.recordArrival({ channelId: "ch_dead", serverId: "srv_1", seq: 1 })

    capturedOnMessage!({
      type: "community:channel.delete",
      serverId: "srv_1",
      channelId: "ch_dead",
    } satisfies CommunityChannelDelete)

    expect(unreadProjection.projectUnread("inbox-unreads", "ch_dead", true, 1)).toBe(false)
  })

  it("removes channelMessages, pins, and threads for the deleted channel", async () => {
    await mountHook()
    // Seed every canonical cache for the target channel so we can observe eviction.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_dead"), {
      pages: [{ messages: [{ id: "m_1" }], hasMore: false }],
      pageParams: [null],
    })
    capturedQueryClient.setQueryData(communityKeys.pins("ch_dead"), { pins: [{ id: "p" }] })
    capturedQueryClient.setQueryData(communityKeys.threads("ch_dead"), { threads: [{ id: "t" }] })
    const sidebarKey = communityKeys.forumSidebarThreads("srv_1")
    capturedQueryClient.setQueryData(sidebarKey, forumSidebarFixture(["ch_dead"]))

    const event: CommunityChannelDelete = {
      type: "community:channel.delete",
      serverId: "srv_1",
      channelId: "ch_dead",
    }
    capturedOnMessage!(event)

    expect(capturedQueryClient.getQueryData(communityKeys.channelMessages("ch_dead"))).toBeUndefined()
    expect(capturedQueryClient.getQueryData(communityKeys.pins("ch_dead"))).toBeUndefined()
    expect(capturedQueryClient.getQueryData(communityKeys.threads("ch_dead"))).toBeUndefined()
    expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(sidebarKey)?.threads).toEqual([])
  })

  it("evicts the deleted row while an active server-tree refetch is pending", async () => {
    await mountHook()
    const serverKey = communityKeys.server("srv_1")
    const deletedChannel = {
      id: "ch_dead",
      name: "Deleted",
      type: "text" as const,
      position: 0,
      createdAt: "2026-07-03T00:00:00.000Z",
    }
    const freshServer = {
      id: "srv_1",
      name: "Server",
      discriminator: "0001",
      description: "",
      icon: null,
      ownerId: "u_owner",
      categories: [{ id: "cat_1", name: "Category", private: 0, channels: [] }],
    }
    capturedQueryClient.setQueryData(serverKey, {
      ...freshServer,
      categories: [{
        ...freshServer.categories[0],
        channels: [deletedChannel],
      }],
    })
    let resolveServer!: (server: typeof freshServer) => void
    const fetchServer = vi.fn(() => new Promise<typeof freshServer>((resolve) => {
      resolveServer = resolve
    }))
    const observer = new QueryObserver(capturedQueryClient, {
      queryKey: serverKey,
      queryFn: fetchServer,
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => {})

    try {
      capturedOnMessage!({
        type: "community:channel.delete",
        serverId: "srv_1",
        channelId: "ch_dead",
      } satisfies CommunityChannelDelete)

      expect(fetchServer).toHaveBeenCalledTimes(1)
      expect(
        capturedQueryClient.getQueryData<typeof freshServer>(serverKey)?.categories[0].channels,
      ).toEqual([])
      resolveServer(freshServer)
      await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false))
    } finally {
      unsubscribe()
    }
  })

  it("projects a canonical forum-post delete as one unit and ejects the active child", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const replacePath = vi.fn()
    useCommunityStore.getState().registerUiHandlers({ replacePath })
    useCommunityStore.getState().setCurrentServerId("srv_1")
    useCommunityStore.getState().setCurrentChannelId("post_1")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "Post",
      parentChannelId: "forum_1",
      parentMessageId: "opener-post_1",
    })
    const feed = {
      pages: [{
        messages: [
          { id: "opener-post_1", thread: { id: "post_1" } },
          { id: "opener-keep", thread: { id: "post_keep" } },
        ],
        hasMore: false,
      }],
      pageParams: [null],
    }
    capturedQueryClient.setQueryData(communityKeys.channelMessages("forum_1"), feed)
    const forumFeed = {
      pages: [{
        serverId: "srv_1",
        parentType: "forum",
        threads: [
          { id: "post_1", parentMessageId: "opener-post_1" },
          { id: "post_keep", parentMessageId: "opener-keep" },
        ],
        included: {
          parentMessages: [{ id: "opener-post_1" }, { id: "opener-keep" }],
          firstMessages: [{ channelId: "post_1" }, { channelId: "post_keep" }],
          tags: [{ messageId: "opener-post_1" }, { messageId: "opener-keep" }],
          participants: [{ channelId: "post_1" }, { channelId: "post_keep" }],
        },
        hasMore: false,
      }],
      pageParams: [null],
    }
    capturedQueryClient.setQueryData(communityKeys.forumFeed("forum_1", "bug"), forumFeed)
    capturedQueryClient.setQueryData(communityKeys.forumTags("forum_1"), { tags: ["bug"] })
    capturedQueryClient.setQueryData(
      communityKeys.forumSidebarThreads("srv_1"),
      forumSidebarFixture(["post_1", "post_keep"]),
    )
    capturedQueryClient.setQueryData(
      communityKeys.forumOpenerHint("srv_1", "opener-post_1"),
      { id: "opener-post_1", content: "Post" },
    )
    useMessageStreamStore.getState().dispatch({
      kind: "channel",
      id: "forum_1",
      serverId: "srv_1",
    }, {
      type: "wsMessage",
      message: {
        id: "opener-post_1",
        seq: 1,
        type: "chat",
        authorId: "u1",
        authorName: "Alice",
        content: "Post",
        createdAt: "2026-08-23T00:00:00.000Z",
        thread: { id: "post_1", name: "Post", messageCount: 1 },
      },
    })

    capturedOnMessage!({
      type: "community:channel.delete",
      serverId: "srv_1",
      channelId: "post_1",
      parentChannelId: "forum_1",
      parentMessageId: "opener-post_1",
    } satisfies CommunityChannelDelete)

    expect(capturedQueryClient.getQueryData<typeof feed>(communityKeys.channelMessages("forum_1"))
      ?.pages[0].messages.map((message) => message.id)).toEqual(["opener-keep"])
    expect(capturedQueryClient.getQueryData<typeof forumFeed>(communityKeys.forumFeed("forum_1", "bug"))
      ?.pages[0].threads.map((thread) => thread.id)).toEqual(["post_keep"])
    expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(
      communityKeys.forumSidebarThreads("srv_1"),
    )?.threads.map((thread) => thread.id)).toEqual(["post_keep"])
    expect(capturedQueryClient.getQueryData(
      communityKeys.forumOpenerHint("srv_1", "opener-post_1"),
    )).toBeUndefined()
    expect(getMessageOverlay({ kind: "channel", id: "forum_1", serverId: "srv_1" })
      .liveById.has("opener-post_1")).toBe(false)
    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()
    expect(replacePath).toHaveBeenCalledWith("/c/channels/srv_1/forum_1")
    expect(capturedQueryClient.getQueryState(communityKeys.forumTags("forum_1"))?.isInvalidated)
      .toBe(true)
  })
})

describe("useCommunityWs — child_create patches parent thread badge with count 0", () => {
  it("message.create then child_create patches the opener into a forum card", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_parent" })
    resetHookMemoization()
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_parent"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })
    capturedOnMessage!(messageCreate("ch_parent", "m_parent"))

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
    expect(cache?.pages[0].messages).toEqual([])
    const overlay = getMessageOverlay({ kind: "channel", id: "ch_parent", serverId: "s1" })
    expect(overlay.liveById.get("m_parent")?.thread).toEqual({
      id: "ch_thread",
      name: "New thread",
      messageCount: 0,
    })
  })

  it("child_create then message.create invalidates and preserves the enriched forum card", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_parent" })
    resetHookMemoization()
    await mountHook()
    const parentMessagesKey = communityKeys.channelMessages("ch_parent")
    capturedQueryClient.setQueryData(parentMessagesKey, {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })
    const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
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
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: parentMessagesKey })

    capturedQueryClient.setQueryData(parentMessagesKey, {
      pages: [{
        messages: [{
          id: "m_parent",
          content: "hello",
          thread: { id: "ch_thread", name: "New thread", messageCount: 0 },
        }],
        hasMore: false,
      }],
      pageParams: [null],
    })
    capturedOnMessage!(messageCreate("ch_parent", "m_parent"))

    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string; thread?: { id: string } }[] }[]
    }>(parentMessagesKey)
    expect(cache?.pages[0].messages).toHaveLength(1)
    expect(cache?.pages[0].messages[0].thread?.id).toBe("ch_thread")
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

  it("child_update tag changes invalidate every forum feed and the vocabulary", async () => {
    await mountHook()
    const allFeed = communityKeys.forumFeed("forum_1", null)
    const archivedFeed = communityKeys.forumFeed("forum_1", "archived")
    const tags = communityKeys.forumTags("forum_1")
    const messages = communityKeys.channelMessages("forum_1")
    for (const key of [allFeed, archivedFeed, tags, messages]) {
      capturedQueryClient.setQueryData(key, { value: "stale" })
    }

    capturedOnMessage!({
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "post_1",
      changes: { tags: ["archived"] },
    } satisfies CommunityChildChannelUpdate)

    await vi.waitFor(() => {
      for (const key of [allFeed, archivedFeed, tags, messages]) {
        expect(capturedQueryClient.getQueryState(key)?.isInvalidated).toBe(true)
      }
    })
  })

  it("projects remote Archive out of warm All and ordinary feeds synchronously", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(
      communityKeys.forumFeed("forum_1", null),
      forumFeedFixture([{ id: "post_1", opener: "opener_1", tags: ["bug"] }]),
    )
    capturedQueryClient.setQueryData(
      communityKeys.forumFeed("forum_1", "bug"),
      forumFeedFixture([{ id: "post_1", opener: "opener_1", tags: ["bug"] }]),
    )
    capturedQueryClient.setQueryData(
      communityKeys.forumFeed("forum_1", "archived"),
      forumFeedFixture([]),
    )

    capturedOnMessage!({
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "post_1",
      changes: { tags: ["bug", "archived"] },
    } satisfies CommunityChildChannelUpdate)

    expect(forumFeedIds(null)).toEqual([])
    expect(forumFeedIds("bug")).toEqual([])
    expect(forumFeedIds("archived")).toEqual([])
  })

  it("projects remote Unarchive out of Archived without inventing an All rank", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(
      communityKeys.forumFeed("forum_1", "archived"),
      forumFeedFixture([{
        id: "post_1",
        opener: "opener_1",
        tags: ["bug", "archived"],
      }]),
    )
    capturedQueryClient.setQueryData(
      communityKeys.forumFeed("forum_1", null),
      forumFeedFixture([]),
    )

    capturedOnMessage!({
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "post_1",
      changes: { tags: ["bug"] },
    } satisfies CommunityChildChannelUpdate)

    expect(forumFeedIds("archived")).toEqual([])
    expect(forumFeedIds(null)).toEqual([])
  })

  it("leaves warm feeds untouched when parent and child resolve conflicting openers", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(
      communityKeys.forumFeed("forum_1", null),
      forumFeedFixture([{ id: "post_1", opener: "opener_one", tags: ["bug"] }]),
    )
    capturedQueryClient.setQueryData(
      communityKeys.forumFeed("forum_1", "bug"),
      forumFeedFixture([{ id: "post_1", opener: "opener_two", tags: ["bug"] }]),
    )

    capturedOnMessage!({
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "post_1",
      changes: { tags: ["bug", "archived"] },
    } satisfies CommunityChildChannelUpdate)

    expect(forumFeedIds(null)).toEqual(["post_1"])
    expect(forumFeedIds("bug")).toEqual(["post_1"])
  })

  it("archive-tag updates evict only the sidebar projection and keep the active route", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const baseKey = communityKeys.forumSidebarThreads("s1")
    const retainedKey = communityKeys.forumSidebarRetained("s1", "post_1")
    const metaKey = communityKeys.channelMeta("s1", "post_1")
    const hintKey = communityKeys.forumOpenerHint("s1", "opener-post_1")
    const fallbackKey = communityKeys.forumSidebarUnreadFallbacks("s1")
    capturedQueryClient.setQueryData(communityKeys.server("s1"), {
      id: "s1",
      categories: [{ id: "cat_1", channels: [{ id: "forum_1", type: "forum" }] }],
    })
    const base = forumSidebarFixture(["post_1", "post_2"])
    capturedQueryClient.setQueryData(baseKey, base)
    capturedQueryClient.setQueryData(retainedKey, base.threads[0])
    capturedQueryClient.setQueryData(metaKey, {
      id: "post_1",
      parentChannelId: "forum_1",
      parentMessageId: "opener-post_1",
    })
    capturedQueryClient.setQueryData(hintKey, {
      id: "opener-post_1",
      content: "Post one",
    })
    capturedQueryClient.setQueryData(fallbackKey, {
      forum_1: { baseUnread: false, childIds: ["post_1"] },
    })
    useCommunityStore.getState().setCurrentChannelId("post_1")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "Post one",
      parentChannelId: "forum_1",
      parentMessageId: "opener-post_1",
    })

    capturedOnMessage!({
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "post_1",
      changes: { tags: ["bug", "archived"] },
    } satisfies CommunityChildChannelUpdate)

    expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(baseKey)
      ?.threads.map(({ id }) => id)).toEqual(["post_2"])
    expect(capturedQueryClient.getQueryState(retainedKey)).toBeUndefined()
    expect(capturedQueryClient.getQueryData(metaKey)).toMatchObject({ id: "post_1" })
    expect(capturedQueryClient.getQueryData(hintKey)).toEqual({
      id: "opener-post_1",
      content: "Post one",
    })
    expect(capturedQueryClient.getQueryData(fallbackKey)).toEqual({
      forum_1: { baseUnread: false, childIds: ["post_1"] },
    })
    expect(useCommunityStore.getState().currentChannelId).toBe("post_1")
    expect(useCommunityStore.getState().currentChannelMeta).toMatchObject({
      parentMessageId: "opener-post_1",
    })
    await vi.waitFor(() => {
      expect(capturedQueryClient.getQueryState(baseKey)?.isInvalidated).toBe(true)
    })
  })

  it.each([
    ["ordinary tags", ["bug"]],
    ["null tags", null],
  ] as const)("%s keeps the warm projection until the exact-base response", async (_label, tags) => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const baseKey = communityKeys.forumSidebarThreads("s1")
    const retainedKey = communityKeys.forumSidebarRetained("s1", "post_1")
    const metaKey = communityKeys.channelMeta("s1", "post_1")
    const hintKey = communityKeys.forumOpenerHint("s1", "opener-post_1")
    capturedQueryClient.setQueryData(communityKeys.server("s1"), {
      id: "s1",
      categories: [{ id: "cat_1", channels: [{ id: "forum_1", type: "forum" }] }],
    })
    const base = forumSidebarFixture(["post_1", "post_2"])
    capturedQueryClient.setQueryData(baseKey, base)
    capturedQueryClient.setQueryData(retainedKey, base.threads[0])
    capturedQueryClient.setQueryData(metaKey, {
      id: "post_1",
      parentChannelId: "forum_1",
      parentMessageId: "opener-post_1",
    })
    capturedQueryClient.setQueryData(hintKey, {
      id: "opener-post_1",
      content: "Post one",
    })
    useCommunityStore.getState().setCurrentChannelId("post_1")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "Post one",
      parentChannelId: "forum_1",
      parentMessageId: "opener-post_1",
    })

    capturedOnMessage!({
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "post_1",
      changes: { tags },
    } satisfies CommunityChildChannelUpdate)

    expect(capturedQueryClient.getQueryData(baseKey)).toEqual(base)
    expect(capturedQueryClient.getQueryData(retainedKey)).toEqual(base.threads[0])
    expect(capturedQueryClient.getQueryData(metaKey)).toMatchObject({ id: "post_1" })
    expect(capturedQueryClient.getQueryData(hintKey)).toEqual({
      id: "opener-post_1",
      content: "Post one",
    })
    expect(useCommunityStore.getState().currentChannelId).toBe("post_1")
    await vi.waitFor(() => {
      expect(capturedQueryClient.getQueryState(baseKey)?.isInvalidated).toBe(true)
    })
  })

  it("child_update rename patches focused child metadata and its cached channel meta", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("s1")
    useCommunityStore.getState().setCurrentChannelId("ch_thread")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "old",
      parentChannelId: "ch_parent",
      parentMessageId: "m_parent",
    })
    capturedQueryClient.setQueryData(communityKeys.channelMeta("s1", "ch_thread"), {
      id: "ch_thread",
      name: "old",
      parentChannelId: "ch_parent",
    })

    capturedOnMessage!({
      type: "community:channel.child_update",
      parentChannelId: "ch_parent",
      channelId: "ch_thread",
      changes: { name: "new" },
    } satisfies CommunityChildChannelUpdate)

    expect(useCommunityStore.getState().currentChannelMeta?.name).toBe("new")
    expect(capturedQueryClient.getQueryData<{ name: string }>(
      communityKeys.channelMeta("s1", "ch_thread"),
    )?.name).toBe("new")
  })

  it("child_update removes archived sidebar rows and invalidates on reopen", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const key = communityKeys.forumSidebarThreads("s1")
    capturedQueryClient.setQueryData(communityKeys.server("s1"), {
      id: "s1",
      categories: [{ id: "cat_1", channels: [{ id: "forum_1", type: "forum" }] }],
    })
    capturedQueryClient.setQueryData(key, forumSidebarFixture(["ch_thread"]))
    useCommunityStore.getState().setCurrentChannelId("ch_thread")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "Private title",
      parentChannelId: "forum_1",
      parentMessageId: "opener-ch_thread",
    })

    capturedOnMessage!({
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "ch_thread",
      changes: { archived: true, tags: ["bug"] },
    } satisfies CommunityChildChannelUpdate)
    expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(key)?.threads).toEqual([])
    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()

    capturedOnMessage!({
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "ch_thread",
      changes: { archived: false },
    } satisfies CommunityChildChannelUpdate)
    await vi.waitFor(() => {
      expect(capturedQueryClient.getQueryState(key)?.isInvalidated).toBe(true)
    })
  })

  it("clears active child metadata synchronously on channel.delete", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentChannelId("ch_dead")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "Private title",
      parentChannelId: "forum_1",
    })

    capturedOnMessage!({
      type: "community:channel.delete",
      serverId: "srv_1",
      channelId: "ch_dead",
      parentChannelId: "forum_1",
    } satisfies CommunityChannelDelete)

    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()
  })

  it("does not touch forum resources for ordinary text-thread updates", async () => {
    await mountHook()
    const baseKey = communityKeys.forumSidebarThreads("s1")
    const retainedKey = communityKeys.forumSidebarRetained("s1", "forum_post")
    const metaKey = communityKeys.channelMeta("s1", "text_thread")
    const hintKey = communityKeys.forumOpenerHint("s1", "forum_opener")
    capturedQueryClient.setQueryData(communityKeys.server("s1"), {
      id: "s1",
      categories: [{ id: "cat_1", channels: [{ id: "text_parent", type: "text" }] }],
    })
    capturedQueryClient.setQueryData(baseKey, forumSidebarFixture())
    capturedQueryClient.setQueryData(retainedKey, { id: "forum_post" })
    capturedQueryClient.setQueryData(metaKey, { id: "text_thread", parentChannelId: "text_parent" })
    capturedQueryClient.setQueryData(hintKey, { id: "forum_opener", content: "Forum title" })
    const before = [
      capturedQueryClient.getQueryData(baseKey),
      capturedQueryClient.getQueryData(retainedKey),
      capturedQueryClient.getQueryData(metaKey),
      capturedQueryClient.getQueryData(hintKey),
    ]

    for (const changes of [
      { archived: true },
      { archived: false },
      { lastMessageAt: "2026-08-09T00:00:00.000Z" },
    ]) {
      capturedOnMessage!({
        type: "community:channel.child_update",
        parentChannelId: "text_parent",
        channelId: "text_thread",
        changes,
      } satisfies CommunityChildChannelUpdate)
    }

    expect(capturedQueryClient.getQueryState(baseKey)?.isInvalidated).toBe(false)
    expect([
      capturedQueryClient.getQueryData(baseKey),
      capturedQueryClient.getQueryData(retainedKey),
      capturedQueryClient.getQueryData(metaKey),
      capturedQueryClient.getQueryData(hintKey),
    ]).toEqual(before)
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

describe("useCommunityWs — channel.delete refreshes the parent forum feed", () => {
  it("invalidates the parent's message feed + threads list when parentChannelId is present", async () => {
    await mountHook()
    const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const allKey = communityKeys.channelMessages("forum_1")
    const bugKey = [...allKey, "tag", "bug"] as const
    const page = {
      pages: [{ messages: [{ id: "opener_1", thread: { id: "post_1" } }], hasMore: false }],
      pageParams: [null],
    }
    capturedQueryClient.setQueryData(allKey, page)
    capturedQueryClient.setQueryData(bugKey, page)

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
    expect(capturedQueryClient.getQueryData<{ pages: { messages: unknown[] }[] }>(allKey)?.pages[0].messages).toHaveLength(0)
    expect(capturedQueryClient.getQueryData<{ pages: { messages: unknown[] }[] }>(bugKey)?.pages[0].messages).toHaveLength(0)
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

describe("useCommunityWs — server.delete resets store when focused server dies", () => {
  it("fences cached raw Inbox rows from the deleted server", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const unreadProjection = getAccountUnreadProjection(capturedQueryClient, "u_me")
    unreadProjection.recordArrival({ channelId: "ch_dead", serverId: "srv_doomed", seq: 1 })

    capturedOnMessage!({
      type: "community:server.delete",
      serverId: "srv_doomed",
    } satisfies CommunityServerDelete)

    expect(unreadProjection.projectUnread("inbox-unreads", "ch_dead", true, 1)).toBe(false)
  })

  it("clears currentServerId + currentChannelId if the deleted server is currently focused", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_doomed")
    useCommunityStore.getState().setCurrentChannelId("ch_1")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "Private title",
      parentChannelId: "private_parent",
    })

    const event: CommunityServerDelete = {
      type: "community:server.delete",
      serverId: "srv_doomed",
    }
    capturedOnMessage!(event)

    expect(useCommunityStore.getState().currentServerId).toBeNull()
    expect(useCommunityStore.getState().currentChannelId).toBeNull()
    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()
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
