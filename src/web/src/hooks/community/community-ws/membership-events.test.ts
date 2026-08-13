import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CommunityMemberJoin, CommunityMemberLeave, CommunityMemberUpdate } from "@alook/shared"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import { communityKeys } from "@/lib/query-keys"
import {
  subscribeMemberOverlayEvents,
  type MemberOverlayEvent,
} from "@/hooks/community/use-server-members"
import {
  capturedOnMessage,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  forumSidebarFixture,
  mountHook,
  resetCommunityWsHarness,
} from "./test-harness"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — member events", () => {
  it("clears the active private route immediately when the viewer leaves the server", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId("srv_1")
    useCommunityStore.getState().setCurrentChannelId("private_child")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "Private title",
      parentChannelId: "private_parent",
    })
    capturedQueryClient.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      categories: [],
    })

    capturedOnMessage!({
      type: "community:member.leave",
      serverId: "srv_1",
      userId: "u_me",
    } satisfies CommunityMemberLeave)

    expect(useCommunityStore.getState()).toMatchObject({
      currentServerId: null,
      currentChannelId: null,
      currentChannelMeta: null,
    })
    expect(capturedQueryClient.getQueryState(communityKeys.server("srv_1"))).toBeUndefined()
  })

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

  it("refreshes rail and server detail only when the joining member is the viewer", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event = {
      type: "community:member.join",
      serverId: "srv_new",
      member: {
        id: "mem_me",
        userId: "u_me",
        name: "Me",
        discriminator: "0001",
        role: "member",
        joinedAt: "2026-08-14T00:00:00.000Z",
      },
    } satisfies CommunityMemberJoin

    capturedOnMessage!(event)

    expect(spy).toHaveBeenCalledWith({ queryKey: communityKeys.servers(), exact: true })
    expect(spy).toHaveBeenCalledWith({ queryKey: communityKeys.server("srv_new"), exact: true })

    spy.mockClear()
    capturedOnMessage!({
      ...event,
      member: { ...event.member, id: "mem_peer", userId: "u_peer" },
    })
    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.servers(), exact: true })
  })

  it("forwards WS membership changes onto the server-scoped search overlay bus", async () => {
    await mountHook()
    const received: MemberOverlayEvent[] = []
    const unsubscribe = subscribeMemberOverlayEvents((event) => received.push(event))

    capturedOnMessage!({
      type: "community:member.leave",
      serverId: "srv_1",
      userId: "u_gone",
    } satisfies CommunityMemberLeave)
    capturedOnMessage!({
      type: "community:member.update",
      serverId: "srv_1",
      memberId: "mem_1",
      changes: { role: "admin" },
    } satisfies CommunityMemberUpdate)
    unsubscribe()

    expect(received).toEqual([
      { type: "leave", serverId: "srv_1", userId: "u_gone" },
      {
        type: "update",
        serverId: "srv_1",
        event: expect.objectContaining({ memberId: "mem_1" }),
      },
    ])
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

  it("adds/removes the viewer's participating child in the forum sidebar", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    const key = communityKeys.forumSidebarThreads("srv_1")
    capturedQueryClient.setQueryData(key, forumSidebarFixture())
    useCommunityStore.getState().setCurrentChannelId("post_1")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "Private forum title",
      parentChannelId: "forum_1",
      parentMessageId: "opener-post_1",
    })

    capturedOnMessage!({
      type: "community:channel.member_remove",
      serverId: "srv_1",
      channelId: "post_1",
      userId: "u_me",
    })
    expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(key)?.threads).toEqual([])
    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()

    capturedQueryClient.setQueryData(key, forumSidebarFixture([]))
    capturedOnMessage!({
      type: "community:channel.member_add",
      serverId: "srv_1",
      channelId: "post_2",
      userId: "u_me",
    })
    await vi.waitFor(() => {
      expect(capturedQueryClient.getQueryState(key)?.isInvalidated).toBe(true)
    })
  })

  it("does not touch forum resources for a known ordinary text child", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    const baseKey = communityKeys.forumSidebarThreads("srv_1")
    const retainedKey = communityKeys.forumSidebarRetained("srv_1", "forum_post")
    const metaKey = communityKeys.channelMeta("srv_1", "text_thread")
    const hintKey = communityKeys.forumOpenerHint("srv_1", "forum_opener")
    capturedQueryClient.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      categories: [{
        id: "cat_1",
        channels: [{ id: "text_parent", type: "text" }],
      }],
    })
    capturedQueryClient.setQueryData(baseKey, forumSidebarFixture())
    capturedQueryClient.setQueryData(retainedKey, { id: "forum_post" })
    capturedQueryClient.setQueryData(metaKey, {
      id: "text_thread",
      serverId: "srv_1",
      parentChannelId: "text_parent",
      parentMessageId: "text_opener",
      type: "thread",
    })
    capturedQueryClient.setQueryData(hintKey, { id: "forum_opener", content: "Forum title" })
    const before = {
      base: capturedQueryClient.getQueryData(baseKey),
      retained: capturedQueryClient.getQueryData(retainedKey),
      meta: capturedQueryClient.getQueryData(metaKey),
      hint: capturedQueryClient.getQueryData(hintKey),
    }

    capturedOnMessage!({
      type: "community:channel.member_add",
      serverId: "srv_1",
      channelId: "text_thread",
      userId: "u_me",
    })

    expect(capturedQueryClient.getQueryData(baseKey)).toBe(before.base)
    expect(capturedQueryClient.getQueryState(baseKey)?.isInvalidated).toBe(false)
    expect(capturedQueryClient.getQueryData(retainedKey)).toBe(before.retained)
    expect(capturedQueryClient.getQueryData(metaKey)).toBe(before.meta)
    expect(capturedQueryClient.getQueryData(hintKey)).toBe(before.hint)

    useCommunityStore.getState().setCurrentChannelId("text_thread")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "Private title",
      parentChannelId: "text_parent",
    })
    capturedOnMessage!({
      type: "community:channel.member_remove",
      serverId: "srv_1",
      channelId: "text_thread",
      userId: "u_me",
    })

    expect(capturedQueryClient.getQueryData(baseKey)).toBe(before.base)
    expect(capturedQueryClient.getQueryState(baseKey)?.isInvalidated).toBe(false)
    expect(capturedQueryClient.getQueryData(retainedKey)).toBe(before.retained)
    expect(capturedQueryClient.getQueryState(metaKey)).toBeUndefined()
    expect(capturedQueryClient.getQueryData(hintKey)).toBe(before.hint)
    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()
  })
})
