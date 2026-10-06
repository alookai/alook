import { readCurrentCommunityChannelMeta } from "@/stores/community/runtime"
import { act } from "@/test/react-dom-harness"
import { seedCanonicalFocusedChannel } from "./test-harness"
import { getCapturedRuntime, seedCanonicalStream, mountCanonicalHook } from "./test-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryObserver } from "@tanstack/react-query"
import { ApiError } from "@/lib/errors"
import { channelMetadataOptions, isChannelMetadataTokenCurrent } from "@/hooks/community/channel-metadata"
import type { CommunityMemberJoin, CommunityMemberLeave, CommunityMemberUpdate } from "@alook/shared"
import { deriveCommunityDeliveryOperationId, encodeCommunityBrowserEventBatch, prepareCommunityDeliveryEvents } from "@alook/shared"
import { getMessageOverlay } from "@/stores/community/message-stream"
import type { PresenceResponse } from "@/hooks/community/use-server-panels"
import { communityKeys } from "@/lib/query-keys"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import {
  getCanonicalCommunityChannels,
  patchCanonicalCommunityChannel,
  setCanonicalCommunityChannelMember,
} from "@/lib/community-db/sync"
import { useChannelMetadata } from "@/hooks/community/use-channel-metadata"
import { useServerMembers } from "@/hooks/community/use-server-members"
import {
  capturedOnMessage,
  capturedQueryClient,
  hasCanonicalChannel,
  hasCanonicalChannelAccess,
  hasCanonicalChannelNotify,
  cleanupCommunityWsHarness,
  forumSidebarFixture,
  getCommunityApiFetchMock,
  mountHook,
  resetCommunityWsHarness,
  seedCanonicalForumSidebar,
  seedCanonicalThread,
} from "./test-harness"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — member events", () => {
  it("clears the active private route immediately when the viewer leaves the server", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const unreadProjection = getAccountUnreadProjection(capturedQueryClient, "u_me")
    unreadProjection.recordArrival({ channelId: "private_child", serverId: "srv_1", seq: 1 })
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.setCurrentServerId("srv_1")
    getCapturedRuntime().ui.actions.setCurrentChannelId("private_child")
    seedCanonicalFocusedChannel({
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

    seedCanonicalStream(
      { kind: "channel", id: "stream-only-child", serverId: "srv_1" },
      { type: "wsMessage", message: {
        id: "stream-only-message", seq: 1, authorId: "author", authorName: "Author",
        authorAvatar: "", authorAvatarVersion: 0, content: "private", type: "chat",
        createdAt: "2026-09-05T00:00:00.000Z",
      } },
    )

    capturedOnMessage!({
      type: "community:member.leave",
      serverId: "srv_1",
      userId: "u_me",
    } satisfies CommunityMemberLeave)

    expect(getCapturedRuntime().ui.get()).toMatchObject({
      currentServerId: null,
      currentChannelId: null,
    })
    expect(capturedQueryClient.getQueryState(communityKeys.server("srv_1"))).toBeUndefined()
    expect(capturedQueryClient.getQueryState(communityKeys.reactionDetails("message_1"))).toBeUndefined()
    expect(capturedQueryClient.getQueryState(communityKeys.reactionDetails("message_2"))).toBeDefined()
    expect(unreadProjection.projectUnread("servers", "private_child", false)).toBe(false)
    expect(unreadProjection.projectUnread("inbox-unreads", "private_child", true, 1)).toBe(false)
  })

  it("evicts an unresolved reaction-details request when the viewer leaves", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const key = communityKeys.reactionDetails("pending_message")
    void capturedQueryClient.query({
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
    const members = await mountCanonicalHook(() => useServerMembers("srv_1"))
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
    expect(cache?.pages[0].members[0]).toEqual({ id: "mem_1", userId: "u_1" })
    await vi.waitFor(() => expect(members.result.current.members[0]).toMatchObject({
      userId: "u_1",
      name: "n",
      discriminator: "0000",
      avatarVersion: 0,
      sub: "",
    }))
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(getCapturedRuntime().ws.get()).not.toHaveProperty("profilesByUserId")
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

    await capturedQueryClient.query({ queryKey: affectedKey, queryFn: affectedQuery })
    await capturedQueryClient.query({ queryKey: otherKey, queryFn: otherQuery })
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
    const server = (id: string) => {
      capturedOnMessage!({ type: "community:member.join", serverId: id, member: { id: `${id}-gone`, userId: "u_gone", name: "Gone", discriminator: "0001", avatarVersion: 0, role: "member", joinedAt: "2026-07-03T00:00:00.000Z" } })
      capturedOnMessage!({ type: "community:member.join", serverId: id, member: { id: `${id}-remaining`, userId: "u_remaining", name: "Remaining", discriminator: "0002", avatarVersion: 0, role: "member", joinedAt: "2026-07-03T00:00:00.000Z" } })
      const key = [...communityKeys.members(id), "search", "g"]
      capturedQueryClient.setQueryData(key, { pages: [{ members: [{ id: `${id}-gone`, userId: "u_gone" }, { id: `${id}-remaining`, userId: "u_remaining" }], hasMore: false, limit: 50 }], pageParams: [null] })
      return key
    }
    const current = server("srv_1"), other = server("srv_2")
    const otherBefore = capturedQueryClient.getQueryData(other)

    capturedOnMessage!({
      type: "community:member.leave",
      serverId: "srv_1",
      userId: "u_gone",
    } satisfies CommunityMemberLeave)
    capturedOnMessage!({
      type: "community:member.update",
      serverId: "srv_1",
      memberId: "srv_1-remaining",
      changes: { role: "admin" },
    } satisfies CommunityMemberUpdate)
    expect(capturedQueryClient.getQueryData<{ pages: Array<{ members: Array<{ userId: string }> }> }>(current)?.pages[0]?.members.map((member) => member.userId)).toEqual(["u_remaining"])
    expect(capturedQueryClient.getQueryData(other)).toBe(otherBefore)
    const registry = (await import("./test-harness")).canonicalRegistry!
    expect([...registry.collections.serverMemberships.values()].find((row) => row.serverId === "srv_1" && row.userId === "u_remaining")?.role).toBe("admin")
    expect([...registry.collections.serverMemberships.values()].find((row) => row.serverId === "srv_2" && row.userId === "u_remaining")?.role).toBe("member")
  })

  it("keeps message snapshots raw when member.update carries a rename", async () => {
    await mountHook()
    seedCanonicalStream(
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
      getMessageOverlay(capturedQueryClient, { kind: "dm", id: "dm_overlay" }).liveById.get("m_overlay")?.authorName,
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
  it("retires notification arrivals on participant removal without retiring access", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    seedCanonicalThread("srv_1", "private_parent", "forum", "private")
    const projection = getAccountUnreadProjection(capturedQueryClient, "u_me")
    projection.recordArrival({ channelId: "private", serverId: "srv_1", seq: 1 })
    capturedOnMessage!({ type: "community:channel.member_remove", serverId: "srv_1", channelId: "private", userId: "u_me" })
    expect(projection.projectUnread("inbox-unreads", "private", true, 1)).toBe(false)
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("private")).toBe(false)
    projection.recordArrival({ channelId: "private", serverId: "srv_1", seq: 2 })
    expect(projection.projectUnread("inbox-unreads", "private", false)).toBe(true)
  })


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
    seedCanonicalThread("srv_1", "ch_1", "text", "private-child")
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

    expect(hasCanonicalChannel("ch_1")).toBe(false)
  })

  it("adds/removes the viewer's participating child in the forum sidebar", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    const key = communityKeys.forumSidebarThreads("srv_1")
    await act(async () => { seedCanonicalForumSidebar("srv_1", ["post_1", "post_2"]) })
    await act(async () => { patchCanonicalCommunityChannel(capturedQueryClient, "post_1", (row) => ({
      ...row,
      unread: true,
    })) })
    await act(async () => { getCapturedRuntime().ui.actions.setCurrentChannelId("post_1") })
    await act(async () => { seedCanonicalFocusedChannel({
      name: "Private forum title",
      parentChannelId: "forum_1",
      parentMessageId: "opener-post_1",
    }) })

    const { useCommunityWsStore } = await import("@/stores/community/ws")
    await act(async () => { capturedOnMessage!({
      type: "community:channel.member_remove",
      serverId: "srv_1",
      channelId: "post_1",
      userId: "u_me",
    }) })
    expect(hasCanonicalChannelAccess("post_1", "u_me")).toBe(true)
    expect(hasCanonicalChannelNotify("post_1", "u_me")).toBe(false)
    expect(getCanonicalCommunityChannels(capturedQueryClient)
      .find(({ id }) => id === "post_1")?.unread).toBe(false)
    expect(readCurrentCommunityChannelMeta(capturedQueryClient)?.name).toBe("Private forum title")

    await act(async () => { capturedOnMessage!({
      type: "community:channel.member_add",
      serverId: "srv_1",
      channelId: "post_2",
      userId: "u_me",
    }) })
    expect(hasCanonicalChannelAccess("post_2", "u_me")).toBe(true)
  })

  it("does not touch forum resources for a known ordinary text child", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    const baseKey = communityKeys.forumSidebarThreads("srv_1")
    const retainedKey = communityKeys.forumSidebarRetained("srv_1", "forum_post")
    const metaKey = communityKeys.channelMeta("srv_1", "text_thread")
    const hintKey = communityKeys.forumOpenerHint("srv_1", "forum_opener")
    seedCanonicalThread("srv_1", "text_parent", "text", "text_thread")
    capturedQueryClient.setQueryData(communityKeys.server("srv_1"), {
      id: "srv_1",
      categories: [{
        id: "cat_1",
        channels: [{ id: "text_parent", type: "text" }],
      }],
    })
    capturedQueryClient.setQueryData(baseKey, forumSidebarFixture())
    capturedQueryClient.setQueryData(retainedKey, { id: "forum_post" })
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

    getCapturedRuntime().ui.actions.setCurrentChannelId("text_thread")
    seedCanonicalFocusedChannel({
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
    expect(capturedQueryClient.getQueryData(metaKey)).toBe(before.meta)
    expect(capturedQueryClient.getQueryData(hintKey)).toBe(before.hint)
    expect(readCurrentCommunityChannelMeta(capturedQueryClient)?.name).toBe("Private title")
    expect(hasCanonicalChannelAccess("text_thread", "u_me")).toBe(true)
    expect(hasCanonicalChannelNotify("text_thread", "u_me")).toBe(false)
  })
})

describe("membership metadata and access lifetime", () => {
  it.each(["text", "forum"] as const)("replaces an in-flight %s child metadata read when participation changes again", async (parentType) => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalThread("server", "parent", parentType, "child")
    const payload = {
      id: "child", serverId: "server", type: "thread", parentChannelId: "parent",
      parentMessageId: "opener", creatorId: "u_me", name: "Current child", archived: false,
      lastMessageAt: null, createdAt: "2026-08-01T00:00:00.000Z",
    }
    const api = getCommunityApiFetchMock()
    api.mockResolvedValue(payload)
    const metadata = await mountCanonicalHook(() => useChannelMetadata("server", "child"))
    await vi.waitFor(() => expect(metadata.result.current.isVerified).toBe(true))
    const key = communityKeys.channelMessages("child")
    const content = { pages: [{ messages: [{ id: "m1" }] }] }
    act(() => capturedQueryClient.setQueryData(key, content))
    const reads: Array<{ signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = []
    api.mockImplementation(async (...args: unknown[]) => {
      if (args[0] !== "/api/community/channels/child") return payload
      return await new Promise((resolve, reject) => {
        reads.push({ signal: (args[1] as { signal: AbortSignal }).signal, resolve, reject })
      })
    })
    capturedOnMessage!({ type: "community:channel.member_add", channelId: "child", serverId: "server", userId: "u_me" })
    await vi.waitFor(() => expect(reads).toHaveLength(1))
    capturedOnMessage!({ type: "community:channel.member_remove", channelId: "child", serverId: "server", userId: "u_me" })
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    expect(reads[0]!.signal.aborted).toBe(true)
    expect(reads[1]!.signal.aborted).toBe(false)
    await act(async () => {
      if (parentType === "text") reads[0]!.resolve({ ...payload, name: "Old archived child", archived: true })
      else reads[0]!.reject(new ApiError("Old denial", 403))
    })
    expect(metadata.result.current.data?.name).not.toBe("Old archived child")
    expect(metadata.result.current.isVerified).toBe(false)
    await act(async () => reads[1]!.resolve(payload))
    await vi.waitFor(() => expect(metadata.result.current.isVerified).toBe(true))
    expect(isChannelMetadataTokenCurrent(metadata.result.current.data!.verification!)).toBe(true)
    expect(metadata.result.current.data).toMatchObject({ name: "Current child", archived: false })
    expect(capturedQueryClient.getQueryData(key)).toEqual(content)
    expect(hasCanonicalChannelAccess("child", "u_me")).toBe(true)
    expect(hasCanonicalChannelNotify("child", "u_me")).toBe(false)
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("child")).toBe(false)
  })

  it("hands one batched add/remove to the latest participation generation", async () => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalThread("server", "parent", "text", "child")
    const payload = {
      id: "child", serverId: "server", type: "thread", parentChannelId: "parent", parentMessageId: "opener",
      creatorId: "u_me", name: "Child", archived: false, lastMessageAt: null, createdAt: "2026-08-01T00:00:00.000Z",
    }
    const api = getCommunityApiFetchMock()
    api.mockResolvedValue(payload)
    const metadata = await mountCanonicalHook(() => useChannelMetadata("server", "child"))
    await vi.waitFor(() => expect(metadata.result.current.isVerified).toBe(true))
    const before = api.mock.calls.filter(([path]) => path === "/api/community/channels/child").length
    const events = [
      { type: "community:channel.member_add", channelId: "child", serverId: "server", userId: "u_me" },
      { type: "community:channel.member_remove", channelId: "child", serverId: "server", userId: "u_me" },
    ] as const
    const prepared = await prepareCommunityDeliveryEvents(events)
    if (!prepared.ok) throw new Error("Participant events must prepare")
    const encoded = await encodeCommunityBrowserEventBatch({
      operationId: await deriveCommunityDeliveryOperationId("participation-change"),
      operationDigest: prepared.prepared.digest,
      events,
    })
    if (!encoded.ok) throw new Error("Participant events must encode")
    act(() => capturedOnMessage!(encoded.batch))
    await vi.waitFor(() => expect(metadata.result.current.isVerified).toBe(true))
    expect(api.mock.calls.filter(([path]) => path === "/api/community/channels/child")).toHaveLength(before + 1)
    expect(isChannelMetadataTokenCurrent(metadata.result.current.data!.verification!)).toBe(true)
    expect(hasCanonicalChannelNotify("child", "u_me")).toBe(false)
  })

  it("settles a failed current-generation read without rebuilding it and recovers on explicit Retry", async () => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalThread("server", "parent", "forum", "child")
    const payload = {
      id: "child", serverId: "server", type: "thread", parentChannelId: "parent", parentMessageId: "opener",
      creatorId: "u_me", name: "Child", archived: false, lastMessageAt: null, createdAt: "2026-08-01T00:00:00.000Z",
    }
    const api = getCommunityApiFetchMock()
    api.mockResolvedValue(payload)
    const metaKey = communityKeys.channelMeta("server", "child")
    capturedQueryClient.setQueryDefaults(metaKey, { retryDelay: 0 })
    const metadata = await mountCanonicalHook(() => useChannelMetadata("server", "child"))
    await vi.waitFor(() => expect(metadata.result.current.isVerified).toBe(true))
    const before = api.mock.calls.filter(([path]) => path === "/api/community/channels/child").length
    api.mockRejectedValue(new ApiError("temporary", 503))
    capturedOnMessage!({ type: "community:channel.member_remove", channelId: "child", serverId: "server", userId: "u_me" })
    await vi.waitFor(() => expect(metadata.result.current).toMatchObject({ isError: true, fetchStatus: "idle", isVerified: false }))
    expect(api.mock.calls.filter(([path]) => path === "/api/community/channels/child")).toHaveLength(before + 2)
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)) })
    expect(api.mock.calls.filter(([path]) => path === "/api/community/channels/child")).toHaveLength(before + 2)
    api.mockResolvedValue(payload)
    await act(async () => { await metadata.result.current.refetch({ cancelRefetch: false }) })
    await vi.waitFor(() => expect(metadata.result.current.isVerified).toBe(true))
    expect(api.mock.calls.filter(([path]) => path === "/api/community/channels/child")).toHaveLength(before + 3)
  })

  it.each(["parent", "server", "account", "unmount"] as const)("does not restart participation metadata after %s retirement before handoff", async (race) => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalThread("server", "parent", "forum", "child")
    const payload = {
      id: "child", serverId: "server", type: "thread", parentChannelId: "parent", parentMessageId: "opener",
      creatorId: "u_me", name: "Child", archived: false, lastMessageAt: null, createdAt: "2026-08-01T00:00:00.000Z",
    }
    const api = getCommunityApiFetchMock()
    api.mockResolvedValue(payload)
    const metadata = await mountCanonicalHook(() => useChannelMetadata("server", "child"))
    await vi.waitFor(() => expect(metadata.result.current.isVerified).toBe(true))
    const metaKey = communityKeys.channelMeta("server", "child")
    const original = capturedQueryClient.getQueryCache().find({ queryKey: metaKey, exact: true })
    const observer = race === "account"
      ? new QueryObserver(capturedQueryClient, channelMetadataOptions(capturedQueryClient, "server", "child")) : null
    const unsubscribe = observer?.subscribe(() => {})
    if (race === "account") act(() => metadata.unmount())
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const cancel = capturedQueryClient.cancelQueries.bind(capturedQueryClient)
    vi.spyOn(capturedQueryClient, "cancelQueries").mockImplementation(async (...args) => { await cancel(...args); await gate })
    const before = api.mock.calls.filter(([path]) => path === "/api/community/channels/child").length
    await act(async () => {
      capturedOnMessage!({ type: "community:channel.member_remove", channelId: "child", serverId: "server", userId: "u_me" })
      if (race === "parent") capturedOnMessage!({ type: "community:channel.member_remove", channelId: "parent", serverId: "server", userId: "u_me" })
      else if (race === "server") capturedOnMessage!({ type: "community:member.leave", serverId: "server", userId: "u_me" })
      else if (race === "account") getCapturedRuntime().ws.actions.activateProfileAccount("other")
      else metadata.unmount()
    })
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve() })
    expect(api.mock.calls.filter(([path]) => path === "/api/community/channels/child")).toHaveLength(before)
    if (race === "parent" || race === "server") {
      const current = capturedQueryClient.getQueryCache().find({ queryKey: metaKey, exact: true })
      expect(current).not.toBe(original)
      expect(current?.state.data).toBeUndefined()
      expect(hasCanonicalChannel("child")).toBe(false)
      expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("child", "server")).toBe(true)
    }
    unsubscribe?.()
  })

  it.each(["text", "forum"] as const)("keeps %s child content after notify removal with ID-only metadata", async (parentType) => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalThread("server", "parent", parentType, "child")
    act(() => { setCanonicalCommunityChannelMember(capturedQueryClient, "child", "u_me", "notify", true) })
    getCommunityApiFetchMock().mockResolvedValue({
      id: "child", serverId: "server", type: "thread", parentChannelId: "parent",
      parentMessageId: "opener", creatorId: "u_me", name: "Child", archived: false,
      lastMessageAt: null, createdAt: "2026-08-01T00:00:00.000Z",
    })
    const metadata = await mountCanonicalHook(() => useChannelMetadata("server", "child"))
    await vi.waitFor(() => expect(metadata.result.current.isVerified).toBe(true))
    const key = communityKeys.channelMessages("child")
    const metaKey = communityKeys.channelMeta("server", "child")
    expect(capturedQueryClient.getQueryData(metaKey)).not.toHaveProperty("type")
    const content = { pages: [{ messages: [{ id: "m1" }] }] }
    act(() => { capturedQueryClient.setQueryData(key, content) })
    capturedOnMessage!({ type: "community:channel.member_remove", channelId: "child", serverId: "server", userId: "u_me" })
    await vi.waitFor(() => expect(metadata.result.current.isVerified).toBe(true))
    expect(metadata.result.current.data).toMatchObject({ id: "child", type: "thread" })
    expect(hasCanonicalChannelAccess("child", "u_me")).toBe(true)
    expect(hasCanonicalChannel("child")).toBe(true)
    expect(hasCanonicalChannelNotify("child", "u_me")).toBe(false)
    expect(capturedQueryClient.getQueryData(key)).toEqual(content)
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("child")).toBe(false)
  })

  it("resolves a cold notify removal without evicting readable content", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const api = getCommunityApiFetchMock()
    api.mockResolvedValue({ id: "child", serverId: "server", type: "thread", parentChannelId: "parent", parentMessageId: "opener", name: "Child", archived: false })
    const key = communityKeys.channelMessages("child")
    const content = { pages: [{ messages: [{ id: "m1", content: "readable" }] }] }
    capturedQueryClient.setQueryData(key, content)
    capturedOnMessage!({ type: "community:channel.member_remove", channelId: "child", serverId: "server", userId: "u_me" })
    await vi.waitFor(() => expect(capturedQueryClient.getQueryData(communityKeys.channelMeta("server", "child"))).toMatchObject({ id: "child", verification: expect.any(Object) }))
    expect(capturedQueryClient.getQueryData(communityKeys.channelMeta("server", "child"))).not.toHaveProperty("type")
    const metadata = await mountCanonicalHook(() => useChannelMetadata("server", "child"))
    await vi.waitFor(() => expect(metadata.result.current.isVerified).toBe(true))
    expect(capturedQueryClient.getQueryData(key)).toEqual(content)
  })

  it.each([403, 404, 500])("distinguishes authoritative %s from a temporary metadata failure", async (status) => {
    await mountHook({ viewerUserId: "u_me" })
    const { ApiError } = await import("@/lib/errors")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    getCommunityApiFetchMock().mockRejectedValue(new ApiError("lookup failed", status))
    const key = communityKeys.channelMessages("child")
    capturedQueryClient.setQueryData(key, { pages: [] })
    capturedOnMessage!({ type: "community:channel.member_remove", channelId: "child", serverId: "server", userId: "u_me" })
    await vi.waitFor(() => expect(getCommunityApiFetchMock()).toHaveBeenCalledWith("/api/community/channels/child", expect.anything()))
    await vi.waitFor(() => expect(capturedQueryClient.getQueryState(communityKeys.channelMeta("server", "child"))?.fetchStatus ?? "idle").toBe("idle"))
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("child")).toBe(status !== 500)
    expect(capturedQueryClient.getQueryData(key) === undefined).toBe(status !== 500)
  })

  it("discards a slow removal after a newer add and a slow metadata result after server leave", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    let release!: (value: unknown) => void
    const api = getCommunityApiFetchMock()
    api.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    capturedOnMessage!({ type: "community:channel.member_remove", channelId: "child", serverId: "server", userId: "u_me" })
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    const meta = {
      id: "child", serverId: "server", name: "Child", type: "thread",
      parentChannelId: "parent", parentMessageId: "opener", creatorId: null,
      archived: false, lastMessageAt: null,
    }
    api.mockResolvedValue(meta)
    capturedOnMessage!({ type: "community:channel.member_add", channelId: "child", serverId: "server", userId: "u_me" })
    await vi.waitFor(() => expect(capturedQueryClient.getQueryData(communityKeys.channelMeta("server", "child"))).toMatchObject({ id: "child", verification: expect.any(Object) }))
    release({ ...meta, type: "text", parentChannelId: null })
    await Promise.resolve()
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("child")).toBe(false)
    expect(getCanonicalCommunityChannels(capturedQueryClient).find(({ id }) => id === "child")).toMatchObject({ type: "thread" })

    let releaseAfterLeave!: (value: unknown) => void
    api.mockImplementationOnce(() => new Promise((resolve) => { releaseAfterLeave = resolve }))
    capturedOnMessage!({ type: "community:channel.member_add", channelId: "other", serverId: "server", userId: "u_me" })
    await vi.waitFor(() => expect(releaseAfterLeave).toBeTypeOf("function"))
    capturedOnMessage!({ type: "community:member.leave", serverId: "server", userId: "u_me" })
    releaseAfterLeave({ ...meta, id: "other" })
    await Promise.resolve()
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("other", "server")).toBe(true)
    expect(capturedQueryClient.getQueryData(communityKeys.channelMeta("server", "other"))).toBeUndefined()
  })

  it("evicts private descendants and ignores late content after parent removal", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const { useCommunityStore } = await import("@/stores/community")
    seedCanonicalThread("server", "parent", "forum", "child")
    getCapturedRuntime().ws.actions.rememberChannelAccess("server", "parent")
    getCapturedRuntime().ws.actions.rememberChannelAccess("server", "child", "parent")
    capturedQueryClient.setQueryData(communityKeys.pins("child"), { pins: [{ id: "m1" }] })
    getCapturedRuntime().ui.actions.setCurrentServerId("server")
    getCapturedRuntime().ui.actions.setCurrentChannelId("child")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "child" })
    capturedOnMessage!({ type: "community:channel.member_remove", channelId: "parent", serverId: "server", userId: "u_me" })
    expect(capturedQueryClient.getQueryData(communityKeys.pins("child"))).toBeUndefined()
    expect(getCapturedRuntime().ui.get().currentChannelId).toBeNull()
    capturedOnMessage!({ type: "community:message.create", channelId: "child", parentChannelId: "parent", serverId: "server", message: {
      id: "late", seq: 2, authorId: "author", authorName: "Author", authorAvatarVersion: 0, content: "late", type: "chat", createdAt: "2026-09-06T00:00:00.000Z",
    } })
    expect(getMessageOverlay(capturedQueryClient, { kind: "channel", id: "child", serverId: "server" }).liveById.size).toBe(0)
  })
})
