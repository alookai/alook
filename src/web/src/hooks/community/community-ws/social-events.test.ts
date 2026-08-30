import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CommunityFriendBlock,
  CommunityFriendRequest,
  CommunityMentionCreate,
} from "@alook/shared"
import { getMessageOverlay } from "@/stores/community/message-stream"
import { communityKeys } from "@/lib/query-keys"
import { getActiveAccountUnreadProjection } from "../account-unread-projection"
import {
  capturedOnMessage,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  messageCreate,
  mountHook,
  resetCommunityWsHarness,
  resetHookMemoization,
  unreadBump,
} from "./test-harness"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

describe("useCommunityWs — account unread projection", () => {
  function serverDetailFixture(channelId: string) {
    return {
      id: "srv_open",
      name: "Server",
      description: "",
      icon: null,
      ownerId: "u_owner",
      categories: [{
        id: "cat_A",
        name: "Category A",
        channels: [{
          id: channelId,
          name: "random",
          type: "text",
          active: false,
          unread: false,
        }],
      }],
    }
  }

  it("records a viewer bump without mutating raw server resources", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const key = communityKeys.server("srv_open")
    const raw = serverDetailFixture("ch_random")
    capturedQueryClient.setQueryData(key, raw)

    capturedOnMessage!(unreadBump("ch_random", "u_me", { serverId: "srv_open" }))

    expect(capturedQueryClient.getQueryData(key)).toBe(raw)
    const projection = getActiveAccountUnreadProjection(capturedQueryClient)
    expect(projection.projectServerChannelUnread(
      "srv_open",
      "ch_random",
      [],
    )).toBe(true)
    expect(projection.projectServerUnread("srv_open", [])).toBe(true)
  })

  it("keeps a focused bump unread until the visible-row observer submits a read", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_focused" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    capturedOnMessage!(unreadBump("ch_focused", "u_me", { serverId: "srv_open" }))

    const projection = getActiveAccountUnreadProjection(capturedQueryClient)
    expect(projection.projectUnread(
      "server-detail:srv_open",
      "ch_focused",
      false,
    )).toBe(true)
    projection.recordRead("ch_focused", 999)
    expect(projection.projectUnread(
      "server-detail:srv_open",
      "ch_focused",
      false,
    )).toBe(true)
  })

  it("uses railChannelId only as a parent fallback and leaves raw rows untouched", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const key = communityKeys.server("srv_open")
    const raw = serverDetailFixture("forum_1")
    capturedQueryClient.setQueryData(key, raw)

    capturedOnMessage!(unreadBump("post_1", "u_me", {
      serverId: "srv_open",
      railChannelId: "forum_1",
    }))

    const projection = getActiveAccountUnreadProjection(capturedQueryClient)
    expect(projection.projectForumParentUnread(
      "srv_open",
      "forum_1",
      false,
      undefined,
      new Set(),
    )).toBe(true)
    expect(capturedQueryClient.getQueryData(key)).toBe(raw)
  })

  it("never increments a numeric rail badge from an unsequenced isMention hint", async () => {
    await mountHook({ viewerUserId: "u_me" })
    capturedOnMessage!(unreadBump("ch_a", "u_me", {
      serverId: "srv_x",
      isMention: true,
    }))
    expect(getActiveAccountUnreadProjection(capturedQueryClient)
      .projectServerMentionCount("srv_x", [], 7)).toBe(7)
  })

  it("ignores bumps addressed to a different account", async () => {
    await mountHook({ viewerUserId: "u_me" })
    capturedOnMessage!(unreadBump("ch_random", "someone_else", { serverId: "srv_open" }))
    expect(getActiveAccountUnreadProjection(capturedQueryClient)
      .projectServerUnread("srv_open", [])).toBe(false)
  })

  it("message.create alone syncs content but does not manufacture unread authority", async () => {
    await mountHook({ viewerUserId: "u_me" })
    capturedOnMessage!(messageCreate("ch_random"))
    expect(getActiveAccountUnreadProjection(capturedQueryClient)
      .projectServerUnread("s1", [])).toBe(false)
  })

  it("keeps focused content sync and the existing debounced Inbox refresh", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "u_me" })
      const { useCommunityStore } = await import("@/stores/community")
      useCommunityStore.getState().setCurrentServerId("srv_open")
      useCommunityStore.getState().subscribe({ channelId: "ch_focused" })
      resetHookMemoization()
      await mountHook({ viewerUserId: "u_me" })
      const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")

      capturedOnMessage!(messageCreate("ch_focused"))
      await vi.advanceTimersByTimeAsync(500)

      expect(getMessageOverlay({
        kind: "channel",
        id: "ch_focused",
        serverId: "s1",
      }).liveById.has("m_1")).toBe(true)
      expect(invalidateSpy.mock.calls.some((call) => (
        (call[0]?.queryKey as unknown[] | undefined)?.includes("inbox")
      ))).toBe(true)
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
    expect(spy.mock.calls.some((call) => (
      (call[0]?.queryKey as unknown[] | undefined)?.includes("friends")
    ))).toBe(true)
  })

  it("friend.block evicts cached DM reactor identities", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.reactionDetails("dm_message"), {
      messageId: "dm_message",
      scope: { kind: "dm", channelId: "dm_1" },
      actors: [],
    })
    capturedQueryClient.setQueryData(communityKeys.reactionDetails("server_message"), {
      messageId: "server_message",
      scope: { kind: "server", serverId: "server_1", channelId: "channel_1" },
      actors: [],
    })
    capturedOnMessage!({
      type: "community:friend.block",
      userId: "blocked_1",
    } satisfies CommunityFriendBlock)
    expect(capturedQueryClient.getQueryState(communityKeys.reactionDetails("dm_message"))).toBeUndefined()
    expect(capturedQueryClient.getQueryState(communityKeys.reactionDetails("server_message"))).toBeDefined()
  })

  it("routes mention.create through the debounced Inbox owner", async () => {
    vi.useFakeTimers()
    try {
      await mountHook()
      const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
      const event: CommunityMentionCreate = {
        type: "community:mention.create",
        userId: "u_1",
        messageId: "m_1",
        authorName: "A",
      }
      capturedOnMessage!(event)
      expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.inbox() })
      await vi.advanceTimersByTimeAsync(500)
      expect(spy.mock.calls.some((call) => (
        (call[0]?.queryKey as unknown[] | undefined)?.includes("inbox")
      ))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("mention.create invalidates servers so authoritative source counts refresh", async () => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event: CommunityMentionCreate = {
      type: "community:mention.create",
      userId: "u_1",
      messageId: "m_1",
      authorName: "A",
    }
    capturedOnMessage!(event)
    expect(spy.mock.calls.filter((call) => {
      const key = call[0]?.queryKey as unknown[] | undefined
      return key?.length === 2 && key[0] === "community" && key[1] === "servers"
    })).toHaveLength(1)
  })
})
