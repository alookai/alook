import { getCapturedRuntime } from "./test-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CommunityFriendBlock,
  CommunityMentionCreate,
  CommunityWsEvent,
} from "@alook/shared"
import {
  deriveCommunityDeliveryOperationId,
  encodeCommunityBrowserEventBatch,
  prepareCommunityDeliveryEvents,
} from "@alook/shared"
import { getMessageStreamState } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { getActiveAccountUnreadProjection } from "../account-unread-projection"
import { act } from "@/test/react-dom-harness"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, ingestDms, publishCommunityMessages } from "@/lib/community-db/sync"
import { channelMetadataOptions, captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "../channel-metadata"
import {
  capturedOnMessage,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  getCommunityApiFetchMock,
  messageCreate,
  mountHook,
  resetCommunityWsHarness,
  resetHookMemoization,
  unreadBump,
  seedCanonicalMessages,
  canonicalMessage,
} from "./test-harness"

const desktopMode = vi.hoisted(() => ({ value: true }))
const notificationMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  show: vi.fn(async () => undefined),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, isDesktop: vi.fn(() => desktopMode.value) }
})
vi.mock("@/lib/community/desktop-system-notification", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/desktop-system-notification")>(
    "@/lib/community/desktop-system-notification",
  )
  notificationMocks.resolve.mockImplementation(actual.resolveDesktopSystemNotificationCandidate)
  return {
    ...actual,
    resolveDesktopSystemNotificationCandidate: notificationMocks.resolve,
    showDesktopSystemNotification: notificationMocks.show,
  }
})

beforeEach(async () => {
  desktopMode.value = true
  await resetCommunityWsHarness()
})
afterEach(cleanupCommunityWsHarness)

async function batchFor(messageId: string, events: readonly CommunityWsEvent[]) {
  const operationId = await deriveCommunityDeliveryOperationId(messageId)
  const prepared = await prepareCommunityDeliveryEvents(events)
  if (!prepared.ok) throw new Error("bundle fixture must prepare")
  const encoded = await encodeCommunityBrowserEventBatch({
    operationId,
    operationDigest: prepared.prepared.digest,
    events,
  })
  if (!encoded.ok) throw new Error("bundle fixture must encode")
  return encoded.batch
}

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
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_focused" })
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
      .projectServerMentionCount("srv_x", [], 7)).toBe(0)
  })

  it("merges a valid WS bump before applying the current policy overlay", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const projection = getActiveAccountUnreadProjection(capturedQueryClient)
    projection.setNotificationPolicy({ server: { srv_x: "nothing" } })

    capturedOnMessage!(unreadBump("ch_a", "u_me", { serverId: "srv_x" }))

    expect(projection.inspectForTests().sourceCount).toBe(1)
    expect(projection.projectUnread("servers", "ch_a", false)).toBe(false)
    projection.setNotificationPolicy({ server: { srv_x: "all" } })
    expect(projection.projectUnread("servers", "ch_a", false)).toBe(true)
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
    expect(notificationMocks.show).not.toHaveBeenCalled()
  })

  it("notifies only when message.create and the viewer's unread.bump share one bundle", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const create = messageCreate("dm_1", "message_1")
    capturedOnMessage!(await batchFor("message_1", [
      create,
      unreadBump("dm_1", "u_me"),
    ]))

    await vi.waitFor(() => expect(notificationMocks.show).toHaveBeenCalledOnce())
    expect(notificationMocks.show).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: "u_me",
      target: {
        kind: "dm",
        channelId: "dm_1",
        messageId: "message_1",
        seq: 1,
      },
    }))
  })

  it("does not notify for an orphan unread.bump", async () => {
    await mountHook({ viewerUserId: "u_me" })
    capturedOnMessage!(unreadBump("dm_1", "u_me"))
    expect(notificationMocks.show).not.toHaveBeenCalled()
  })

  it("does not resolve native copy outside the desktop shell", async () => {
    desktopMode.value = false
    await mountHook({ viewerUserId: "u_me" })
    capturedOnMessage!(await batchFor("message_1", [
      messageCreate("dm_1", "message_1"),
      unreadBump("dm_1", "u_me"),
    ]))

    expect(notificationMocks.resolve).not.toHaveBeenCalled()
    expect(notificationMocks.show).not.toHaveBeenCalled()
  })

  it("keeps a native-copy resolution rejection fail-closed", async () => {
    notificationMocks.resolve.mockRejectedValueOnce(new Error("metadata unavailable"))
    await mountHook({ viewerUserId: "u_me" })
    capturedOnMessage!(await batchFor("message_1", [
      messageCreate("dm_1", "message_1"),
      unreadBump("dm_1", "u_me"),
    ]))

    await vi.waitFor(() => expect(notificationMocks.resolve).toHaveBeenCalledOnce())
    expect(notificationMocks.show).not.toHaveBeenCalled()
  })

  it("syncs focused content without refreshing notification surfaces", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "u_me" })
      const { useCommunityStore } = await import("@/stores/community")
      getCapturedRuntime().ui.actions.setCurrentServerId("srv_open")
      getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_focused" })
      resetHookMemoization()
      await mountHook({ viewerUserId: "u_me" })
      const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")

      capturedOnMessage!(messageCreate("ch_focused"))
      await vi.advanceTimersByTimeAsync(500)

      expect(getMessageStreamState(capturedQueryClient, {
        kind: "channel",
        id: "ch_focused",
        serverId: "s1",
      }).liveIds.includes("m_1")).toBe(true)
      expect(invalidateSpy.mock.calls.some((call) => (
        (call[0]?.queryKey as unknown[] | undefined)?.includes("inbox")
      ))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("useCommunityWs — friend + mention → invalidate", () => {
  it.each<CommunityWsEvent>([
    {
      type: "community:friend.request",
      friendship: {
        id: "f_1",
        requesterId: "u_a",
        addresseeId: "u_b",
        status: "pending",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    },
    { type: "community:friend.accept", friendshipId: "f_1" },
    { type: "community:friend.reject", friendshipId: "f_1" },
    { type: "community:friend.remove", friendshipId: "f_1" },
    { type: "community:friend.block", userId: "u_a" },
  ])("$type invalidates Friends and reconciles canonical attention once", async (event) => {
    await mountHook()
    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!(event)
    await vi.waitFor(() => expect(getCommunityApiFetchMock()).toHaveBeenCalledWith(
      "/api/community/users/me/attention",
      expect.objectContaining({ signal: expect.anything() }),
    ))
    const friendCalls = spy.mock.calls.filter((call) => (
      JSON.stringify(call[0]?.queryKey) === JSON.stringify(communityKeys.friends())
    ))
    expect(friendCalls).toHaveLength(1)
    expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => (
      path === "/api/community/users/me/attention"
    ))).toHaveLength(1)
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

  it.each([false, true])("retires a visible DM and late reads with viewer-owned Block=%s, preserving siblings", async (blockedByViewer) => {
    const registry = getCommunityDbRegistry(capturedQueryClient)!
    ingestDms(registry, { conversations: ["u_a", "u_other"].map((userId) => ({
      id: `dm_${userId}`, userId, name: userId, discriminator: "0001", avatar: "A", avatarVersion: 0,
      status: "offline" as const, preview: "old private preview",
    })) })
    seedCanonicalMessages("dm_u_a", [{ id: "private", content: "private body" }])
    seedCanonicalMessages("dm_u_other", [{ id: "other", content: "other body" }])
    const metadata = { id: "dm_u_a", serverId: null, name: null, type: "dm", parentChannelId: null,
      parentMessageId: null, creatorId: null, archived: false, lastMessageAt: null, createdAt: "2026-10-08T00:00:00Z",
      readContractVersion: 2, accessDecision: { channelId: "dm_u_a", canRead: true, canSend: true, canCreateDiscussion: false } }
    const api = getCommunityApiFetchMock()
    const original = api.getMockImplementation()!
    api.mockImplementation((...args: unknown[]) => args[0] === "/api/community/channels/dm_u_a" ? Promise.resolve(metadata) : original(...args))
    await capturedQueryClient.query(channelMetadataOptions(capturedQueryClient, null, "dm_u_a"))
    const proof = captureCommunityLiveSnapshotToken(capturedQueryClient)
    const oldMetadata = captureChannelMetadataToken(capturedQueryClient, "dm_u_a")
    expect(isChannelMetadataTokenCurrent(oldMetadata)).toBe(true)
    expect(canonicalMessage("private")?.content).toBe("private body")
    let release!: (value: typeof metadata) => void
    const held = new Promise<typeof metadata>((resolve) => { release = resolve })
    api.mockImplementation((...args: unknown[]) => args[0] === "/api/community/channels/dm_u_a" ? held : original(...args))
    const pending = capturedQueryClient.query({ ...channelMetadataOptions(capturedQueryClient, null, "dm_u_a"), staleTime: 0 }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(api.mock.calls.filter(([path]) => path === "/api/community/channels/dm_u_a")).toHaveLength(2))
    act(() => {
      getCapturedRuntime().ui.actions.setCurrentChannelId("dm_u_a")
      getCapturedRuntime().ui.setState((state) => ({ ...state, subscription: { dmConversationId: "dm_u_a" } }))
    })
    await mountHook({ viewerUserId: "u_me" })
    capturedOnMessage!({ type: "community:friend.block", userId: "u_a", ...(blockedByViewer ? { blockedByViewer: true } : {}) })
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("dm_u_a", null)).toBe(true)
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("dm_u_other", null)).toBe(false)
    expect(isChannelMetadataTokenCurrent(oldMetadata)).toBe(false)
    expect(registry.collections.messages.has("private")).toBe(false)
    expect(registry.collections.messages.get("other")?.content).toBe("other body")
    expect(registry.collections.channels.get("dm_u_a")?.preview).toBe("")
    expect(registry.collections.channelMemberships.has("dm_u_a:u_a:access")).toBe(true)
    expect(registry.collections.friendships.has("blocked:u_a")).toBe(blockedByViewer)
    expect(getCapturedRuntime().ui.get().subscription.dmConversationId).toBeUndefined()
    expect(() => publishCommunityMessages(capturedQueryClient, { channelId: "dm_u_a", messages: [{ id: "late", content: "late body", type: "chat", seq: 2 }], proof: { token: proof } })).toThrow("Stale community live snapshot")
    capturedOnMessage!(messageCreate("dm_u_a", "late-ws"))
    expect(registry.collections.messages.has("late-ws")).toBe(false)
    await act(async () => { release(metadata); await pending })
    expect(capturedQueryClient.getQueryData(communityKeys.channelMeta(null, "dm_u_a"))).toBeUndefined()
    expect(registry.collections.messages.has("private")).toBe(false)
  })

  it("does not retire the focused DM for an unrelated block or a retired provider", async () => {
    const registry = getCommunityDbRegistry(capturedQueryClient)!
    ingestDms(registry, { conversations: [{ id: "dm_keep", userId: "peer", name: "Peer", discriminator: "0001", avatar: "P", avatarVersion: 0, status: "offline", preview: "keep" }] })
    seedCanonicalMessages("dm_keep", [{ id: "keep", content: "keep body" }])
    await mountHook({ viewerUserId: "u_me" })
    capturedOnMessage!({ type: "community:friend.block", userId: "unrelated" })
    capturedOnMessage!({ type: "community:friend.block", userId: "u_me" })
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("dm_keep", null)).toBe(false)
    act(() => getCapturedRuntime().lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 })))
    capturedOnMessage!({ type: "community:friend.block", userId: "peer" })
    expect(registry.collections.messages.get("keep")?.content).toBe("keep body")
    expect(getCapturedRuntime().ws.actions.isChannelAccessRevoked("dm_keep", null)).toBe(false)
  })

  it("friend.block evicts an unresolved reaction-details request", async () => {
    await mountHook()
    const key = communityKeys.reactionDetails("pending_message")
    void capturedQueryClient.query({
      queryKey: key,
      queryFn: () => new Promise(() => undefined),
    }).catch(() => undefined)
    expect(capturedQueryClient.getQueryState(key)).toBeDefined()

    capturedOnMessage!({
      type: "community:friend.block",
      userId: "blocked_1",
    } satisfies CommunityFriendBlock)

    expect(capturedQueryClient.getQueryState(key)).toBeUndefined()
  })

  it("coalesces mention.create through the canonical attention owner", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "u_1" })
      const event: CommunityMentionCreate = {
        type: "community:mention.create",
        userId: "u_1",
        messageId: "m_1",
        authorName: "A",
      }
      capturedOnMessage!(event)
      await vi.advanceTimersByTimeAsync(500)
      expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => (
        path === "/api/community/users/me/attention"
      ))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("mention.create invalidates servers so authoritative source counts refresh", async () => {
    await mountHook({ viewerUserId: "u_1" })
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

  it("projects a mention-only delivery into its server and parent scope immediately", async () => {
    await mountHook({ viewerUserId: "u_1" })
    const projection = getActiveAccountUnreadProjection(capturedQueryClient)
    projection.setNotificationPolicy({
      server: { srv_1: "mentions" },
      channel: { forum_1: "mentions" },
    })

    capturedOnMessage!(await batchFor("m_1", [
      unreadBump("post_1", "u_1", {
        serverId: "srv_1",
        railChannelId: "forum_1",
        isMention: true,
      }),
      {
        type: "community:mention.create",
        userId: "u_1",
        messageId: "m_1",
        channelId: "post_1",
        authorName: "A",
      },
    ]))

    expect(projection.projectServerUnread("srv_1", [])).toBe(true)
    expect(projection.projectForumParentUnread(
      "srv_1",
      "forum_1",
      false,
      undefined,
      new Set(),
    )).toBe(true)
    projection.retireAccessScope({ kind: "server", serverId: "srv_1" })
    expect(projection.projectServerUnread("srv_1", [])).toBe(false)
  })
})
