import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CommunityMemberJoin, CommunityMemberUpdate } from "@alook/shared"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import { communityKeys } from "@/lib/query-keys"
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

  it("adds/removes the viewer's participating child in the forum sidebar", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const key = communityKeys.forumSidebarThreadsView("srv_1", null)
    capturedQueryClient.setQueryData(key, forumSidebarFixture())

    capturedOnMessage!({
      type: "community:channel.member_remove",
      serverId: "srv_1",
      channelId: "post_1",
      userId: "u_me",
    })
    expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(key)?.threads).toEqual([])

    capturedQueryClient.setQueryData(key, forumSidebarFixture([]))
    capturedOnMessage!({
      type: "community:channel.member_add",
      serverId: "srv_1",
      channelId: "post_2",
      userId: "u_me",
    })
    expect(capturedQueryClient.getQueryState(key)?.isInvalidated).toBe(true)
  })
})
