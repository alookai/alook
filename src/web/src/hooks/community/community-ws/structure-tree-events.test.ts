import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CommunityChannelCreate,
  CommunityChannelDelete,
  CommunityChildChannelCreate,
  CommunityChildChannelUpdate,
  CommunityServerDelete,
  CommunityServerUpdate,
} from "@alook/shared"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import { communityKeys } from "@/lib/query-keys"
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

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

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
      changes: { archived: true },
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
