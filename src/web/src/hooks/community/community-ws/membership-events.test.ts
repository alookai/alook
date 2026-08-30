import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryObserver } from "@tanstack/react-query"
import type { CommunityMemberJoin, CommunityMemberLeave, CommunityMemberUpdate } from "@alook/shared"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import type { PresenceResponse } from "@/hooks/community/use-server-panels"
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
    capturedQueryClient.setQueryData(communityKeys.reactionDetails("message_1"), {
      messageId: "message_1",
      scope: { kind: "server", serverId: "srv_1", channelId: "channel_1" },
      actors: [],
    })
    capturedQueryClient.setQueryData(communityKeys.reactionDetails("message_2"), {
      messageId: "message_2",
      scope: { kind: "server", serverId: "srv_2", channelId: "channel_2" },
      actors: [],
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
    expect(capturedQueryClient.getQueryState(communityKeys.reactionDetails("message_1"))).toBeUndefined()
    expect(capturedQueryClient.getQueryState(communityKeys.reactionDetails("message_2"))).toBeDefined()
  })

  it("evicts an unresolved reaction-details request when the viewer leaves", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const key = communityKeys.reactionDetails("pending_message")
    void capturedQueryClient.fetchQuery({
      queryKey: key,
      queryFn: () => new Promise(() => undefined),
    }).catch(() => undefined)
    expect(capturedQueryClient.getQueryState(key)).toBeDefined()

    capturedOnMessage!({
      type: "community:member.leave",
      serverId: "srv_1",
      userId: "u_me",
    } satisfies CommunityMemberLeave)

    expect(capturedQueryClient.getQueryState(key)).toBeUndefined()
  })

  it("invalidates matching reactor identities when another member leaves", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const matching = communityKeys.reactionDetails("message_1")
    const other = communityKeys.reactionDetails("message_2")
    capturedQueryClient.setQueryData(matching, {
      messageId: "message_1",
      scope: { kind: "server", serverId: "srv_1", channelId: "channel_1" },
      actors: [],
    })
    capturedQueryClient.setQueryData(other, {
      messageId: "message_2",
      scope: { kind: "server", serverId: "srv_2", channelId: "channel_2" },
      actors: [],
    })
    capturedOnMessage!({
      type: "community:member.leave",
      serverId: "srv_1",
      userId: "u_other",
    } satisfies CommunityMemberLeave)
    expect(capturedQueryClient.getQueryState(matching)?.isInvalidated).toBe(true)
    expect(capturedQueryClient.getQueryState(other)?.isInvalidated).toBe(false)
  })

  it("invalidates an unresolved active reaction-details request on member leave", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const key = communityKeys.reactionDetails("pending_message")
    const queryFn = vi.fn(() => new Promise<never>(() => undefined))
    const observer = new QueryObserver(capturedQueryClient, {
      queryKey: key,
      queryFn,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    expect(queryFn).toHaveBeenCalledOnce()

    capturedOnMessage!({
      type: "community:member.leave",
      serverId: "srv_1",
      userId: "u_other",
    } satisfies CommunityMemberLeave)

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2))
    expect(capturedQueryClient.getQueryState(key)?.data).toBeUndefined()
    unsubscribe()
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
        avatarVersion: 0,
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
    expect(cache?.pages[0].members[0]).toMatchObject({
      userId: "u_1",
      name: "n",
      discriminator: "0000",
      avatarVersion: 0,
      sub: "",
    })
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(useCommunityWsStore.getState().profilesByUserId.get("u_1")).toMatchObject({
      name: "n",
      discriminator: "0000",
      avatar: "N",
      avatarVersion: 0,
    })
  })

  it("exact-refetches only the joined server's active presence seed", async () => {
    await mountHook()
    const affectedKey = communityKeys.presence("srv_1")
    const otherKey = communityKeys.presence("srv_2")
    let online: string[] = []
    const affectedQuery = vi.fn(async (): Promise<PresenceResponse> => ({ online }))
    const otherQuery = vi.fn(async (): Promise<PresenceResponse> => ({
      online: ["u_other"],
    }))

    await capturedQueryClient.fetchQuery({ queryKey: affectedKey, queryFn: affectedQuery })
    await capturedQueryClient.fetchQuery({ queryKey: otherKey, queryFn: otherQuery })
    const observer = new QueryObserver(capturedQueryClient, {
      queryKey: affectedKey,
      queryFn: affectedQuery,
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    online = ["u_online"]

    capturedOnMessage!({
      type: "community:member.join",
      serverId: "srv_1",
      member: {
        id: "mem_online",
        userId: "u_online",
        name: "Online member",
        discriminator: "0001",
        avatarVersion: 0,
        role: "member",
        joinedAt: "2026-08-17T00:00:00.000Z",
      },
    } satisfies CommunityMemberJoin)

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: affectedKey,
      exact: true,
      refetchType: "active",
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: otherKey }),
    )
    await vi.waitFor(() => {
      expect(capturedQueryClient.getQueryData(affectedKey)).toEqual({
        online: ["u_online"],
      })
    })

    capturedOnMessage!({
      type: "community:member.join",
      serverId: "srv_1",
      member: {
        id: "mem_offline",
        userId: "u_offline",
        name: "Offline member",
        discriminator: "0002",
        avatarVersion: 0,
        role: "member",
        joinedAt: "2026-08-17T00:01:00.000Z",
      },
    } satisfies CommunityMemberJoin)

    await vi.waitFor(() => {
      expect(affectedQuery).toHaveBeenCalledTimes(3)
    })
    const refreshedSeed = capturedQueryClient.getQueryData<PresenceResponse>(affectedKey)
    expect(refreshedSeed).toEqual({ online: ["u_online"] })
    expect(otherQuery).toHaveBeenCalledTimes(1)
    expect(capturedQueryClient.getQueryData(otherKey)).toEqual({
      online: ["u_other"],
    })
    unsubscribe()
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
        avatarVersion: 0,
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

  it("keeps message snapshots raw when member.update carries a rename", async () => {
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
      { id: "m_1", authorId: "u_renamed", authorName: "OldName", content: "hi" },
      { id: "m_2", authorId: "u_other", authorName: "Someone Else", content: "yo" },
    ])

    const dmCache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string; authorName: string }[] }[]
    }>(communityKeys.dmMessages("dm_1"))
    expect(dmCache?.pages[0].messages).toEqual([
      { id: "m_3", authorId: "u_renamed", authorName: "OldName", content: "sup" },
    ])
    expect(
      getMessageOverlay({ kind: "dm", id: "dm_overlay" }).liveById.get("m_overlay")?.authorName,
    ).toBe("OldName")
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

  it("does not evict channel scope when another user is removed", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const serverKey = communityKeys.server("srv_1")
    const messagesKey = communityKeys.channelMessages("ch_1")
    const pinsKey = communityKeys.pins("ch_1")
    const threadsKey = communityKeys.threads("ch_1")
    capturedQueryClient.setQueryData(messagesKey, { pages: [], pageParams: [] })
    capturedQueryClient.setQueryData(pinsKey, { pins: [] })
    capturedQueryClient.setQueryData(threadsKey, { threads: [] })
    capturedQueryClient.setQueryData(serverKey, {
      id: "srv_1",
      categories: [{ id: "cat_1", channels: [{ id: "ch_1", type: "text" }] }],
    })

    capturedOnMessage!({
      type: "community:channel.member_remove",
      serverId: "srv_1",
      channelId: "ch_1",
      userId: "u_other",
    })

    expect(capturedQueryClient.getQueryState(messagesKey)).toBeDefined()
    expect(capturedQueryClient.getQueryState(pinsKey)).toBeDefined()
    expect(capturedQueryClient.getQueryState(threadsKey)).toBeDefined()
    expect(capturedQueryClient.getQueryData<{
      categories: { channels: { id: string }[] }[]
    }>(serverKey)?.categories[0].channels).toEqual([{ id: "ch_1", type: "text" }])
  })

  it("removes a private channel from the viewer's server tree on access loss", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const serverKey = communityKeys.server("srv_1")
    capturedQueryClient.setQueryData(serverKey, {
      id: "srv_1",
      categories: [{ id: "cat_1", channels: [{ id: "ch_1", type: "text" }] }],
    })

    capturedOnMessage!({
      type: "community:channel.member_remove",
      serverId: "srv_1",
      channelId: "ch_1",
      userId: "u_me",
    })

    expect(capturedQueryClient.getQueryData<{
      categories: { channels: { id: string }[] }[]
    }>(serverKey)?.categories[0].channels).toEqual([])
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
