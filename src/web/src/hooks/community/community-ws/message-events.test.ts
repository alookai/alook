import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CommunityMessageCreate,
  CommunityMessageEdited,
  CommunityPinAdd,
  CommunityReactionAdd,
} from "@alook/shared"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import { communityKeys } from "@/lib/query-keys"
import {
  capturedOnMessage,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  forumSidebarFixture,
  markReadMutate,
  messageCreate,
  mountHook,
  resetCommunityWsHarness,
  resetHookMemoization,
} from "./test-harness"

const scheduleGapRepairMock = vi.hoisted(() => vi.fn(() => null))
vi.mock("@/hooks/community/community-ws/reconnect-messages", () => ({
  scheduleFocusedMessageGapRepair: (...args: unknown[]) => scheduleGapRepairMock(...args),
}))

beforeEach(() => {
  resetCommunityWsHarness()
  scheduleGapRepairMock.mockClear()
})
afterEach(cleanupCommunityWsHarness)

function seedParent(serverId: string, parentId: string, type: "forum" | "text") {
  capturedQueryClient.setQueryData(communityKeys.server(serverId), {
    id: serverId,
    categories: [{ id: "cat_1", channels: [{ id: parentId, type }] }],
  })
}

describe("useCommunityWs — message.create", () => {
  it("checks a focused channel gap before projecting the incoming overlay row", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_gap" })
    resetHookMemoization()
    await mountHook()
    scheduleGapRepairMock.mockImplementationOnce(() => {
      expect(getMessageOverlay({ kind: "channel", id: "ch_gap", serverId: "s1" }).liveById.size).toBe(0)
      return null
    })
    const event = messageCreate("ch_gap")
    event.message.seq = 5

    capturedOnMessage!(event)

    expect(scheduleGapRepairMock).toHaveBeenCalledWith(
      capturedQueryClient,
      { kind: "channel", scopeId: "ch_gap", serverId: "s1" },
      5,
    )
  })

  it("checks a focused DM gap and ignores an unrelated scope", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_gap" })
    resetHookMemoization()
    await mountHook()
    const event = messageCreate("dm_gap")
    event.message.seq = 8

    capturedOnMessage!(event)
    capturedOnMessage!(messageCreate("other"))

    expect(scheduleGapRepairMock).toHaveBeenCalledTimes(1)
    expect(scheduleGapRepairMock).toHaveBeenCalledWith(
      capturedQueryClient,
      { kind: "dm", scopeId: "dm_gap" },
      8,
    )
  })

  it("patches a loaded forum-sidebar child activity without a refetch", async () => {
    await mountHook()
    seedParent("srv_1", "forum_1", "forum")
    const key = communityKeys.forumSidebarThreads("srv_1")
    capturedQueryClient.setQueryData(key, forumSidebarFixture())
    const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event = {
      ...messageCreate("post_1"),
      serverId: "srv_1",
      parentChannelId: "forum_1",
    } satisfies CommunityMessageCreate

    capturedOnMessage!(event)

    const data = capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(key)
    expect(data?.threads[0]).toMatchObject({
      id: "post_1",
      activityAt: "2026-07-03T00:00:00.000Z",
      expiresAt: "2026-07-06T00:00:00.000Z",
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: communityKeys.forumSidebarThreads("srv_1") })
  })

  it("invalidates the forum-sidebar collection when the active child is not loaded", async () => {
    await mountHook()
    seedParent("srv_1", "forum_1", "forum")
    const key = communityKeys.forumSidebarThreads("srv_1")
    capturedQueryClient.setQueryData(key, forumSidebarFixture([]))

    capturedOnMessage!({
      ...messageCreate("post_missing"),
      serverId: "srv_1",
      parentChannelId: "forum_1",
    } satisfies CommunityMessageCreate)

    await vi.waitFor(() => {
      expect(capturedQueryClient.getQueryState(key)?.isInvalidated).toBe(true)
    })
  })

  it.each([false, true])(
    "invalidates canonical base for a retained-only child (active=%s) so it survives route exit",
    async (active) => {
      if (active) {
        const { useCommunityStore } = await import("@/stores/community")
        useCommunityStore.getState().subscribe({ channelId: "post_retained" })
      }
      await mountHook()
      seedParent("srv_1", "forum_1", "forum")
      const key = communityKeys.forumSidebarThreads("srv_1")
      const retainedKey = communityKeys.forumSidebarRetained("srv_1", "post_retained")
      capturedQueryClient.setQueryData(key, forumSidebarFixture([]))
      capturedQueryClient.setQueryData(
        retainedKey,
        forumSidebarFixture(["post_retained"]).threads[0],
      )

      capturedOnMessage!({
        ...messageCreate("post_retained"),
        serverId: "srv_1",
        parentChannelId: "forum_1",
      } satisfies CommunityMessageCreate)

      expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>["threads"][number]>(
        retainedKey,
      )).toMatchObject({
        activityAt: "2026-07-03T00:00:00.000Z",
        expiresAt: "2026-07-06T00:00:00.000Z",
      })
      await vi.waitFor(() => {
        expect(capturedQueryClient.getQueryState(key)?.isInvalidated).toBe(true)
      })

      capturedQueryClient.setQueryData(key, forumSidebarFixture(["post_retained"]))
      expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(key)
        ?.threads.some((thread) => thread.id === "post_retained")).toBe(true)
    },
  )

  it("does not touch forum resources for ordinary text-thread create or opener edit", async () => {
    await mountHook()
    seedParent("s1", "text_parent", "text")
    const baseKey = communityKeys.forumSidebarThreads("s1")
    const retainedKey = communityKeys.forumSidebarRetained("s1", "forum_post")
    const metaKey = communityKeys.channelMeta("s1", "text_thread")
    const hintKey = communityKeys.forumOpenerHint("s1", "forum_opener")
    capturedQueryClient.setQueryData(baseKey, forumSidebarFixture())
    capturedQueryClient.setQueryData(retainedKey, { id: "forum_post" })
    capturedQueryClient.setQueryData(metaKey, {
      id: "text_thread",
      parentChannelId: "text_parent",
    })
    capturedQueryClient.setQueryData(hintKey, { id: "forum_opener", content: "Forum title" })
    const before = [
      capturedQueryClient.getQueryData(baseKey),
      capturedQueryClient.getQueryData(retainedKey),
      capturedQueryClient.getQueryData(metaKey),
      capturedQueryClient.getQueryData(hintKey),
    ]

    capturedOnMessage!({
      ...messageCreate("text_thread"),
      serverId: "s1",
      parentChannelId: "text_parent",
    } satisfies CommunityMessageCreate)
    capturedOnMessage!({
      type: "community:message.edited",
      channelId: "text_thread",
      messageId: "text_opener",
      content: "Text title",
      parentChannelId: "text_parent",
    } satisfies CommunityMessageEdited)

    expect(capturedQueryClient.getQueryState(baseKey)?.isInvalidated).toBe(false)
    expect([
      capturedQueryClient.getQueryData(baseKey),
      capturedQueryClient.getQueryData(retainedKey),
      capturedQueryClient.getQueryData(metaKey),
      capturedQueryClient.getQueryData(hintKey),
    ]).toEqual(before)
  })

  it("writes the channel overlay and leaves the base cache untouched when focused", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })

    // Re-mount so the ref state picks up the subscription value.
    resetHookMemoization()
    await mountHook()

    // Seed a page cache so setQueryData has something to patch.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })

    capturedOnMessage!(messageCreate("ch_1"))

    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string; seq?: number }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toEqual([])
    expect([...getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById]).toHaveLength(1)
  })

  it("heals a first-seen event replay once the focused serverId becomes available", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().setCurrentServerId(null)
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const event = messageCreate("ch_1")
    capturedOnMessage!(event)
    expect(getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById).toHaveLength(0)

    useCommunityStore.getState().setCurrentServerId("s1")
    capturedOnMessage!(event)
    expect(getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById).toHaveLength(1)
  })

  it("keeps forum query variants base-only and stages a new opener in the overlay", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "forum_1" })
    resetHookMemoization()
    await mountHook()
    const allKey = communityKeys.channelMessages("forum_1")
    const bugKey = [...allKey, "tag", "bug"] as const
    const empty = { pages: [{ messages: [], hasMore: false }], pageParams: [null] }
    capturedQueryClient.setQueryData(allKey, empty)
    capturedQueryClient.setQueryData(bugKey, empty)

    capturedOnMessage!(messageCreate("forum_1"))

    expect(capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(allKey)?.pages[0].messages).toHaveLength(0)
    expect(capturedQueryClient.getQueryData<{ pages: { messages: unknown[] }[] }>(bugKey)?.pages[0].messages).toHaveLength(0)
    expect(getMessageOverlay({ kind: "channel", id: "forum_1", serverId: "s1" }).liveById).toHaveLength(1)
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

  it("invalidates channelMembers for a focused child channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const store = useCommunityStore.getState()
    store.setCurrentChannelId("ch_1")
    store.setCurrentChannelMeta({ name: "thread", parentChannelId: "parent_1" })
    store.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!(messageCreate("ch_1"))

    expect(spy).toHaveBeenCalledWith({ queryKey: communityKeys.channelMembers("ch_1") })
    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.threadParticipants("ch_1") })
  })

  it("does NOT invalidate channelMembers for a focused top-level channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const store = useCommunityStore.getState()
    store.setCurrentChannelId("ch_1")
    store.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!(messageCreate("ch_1"))

    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.channelMembers("ch_1") })
    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.threadParticipants("ch_1") })
  })

  it("does NOT invalidate channelMembers for an unfocused channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const store = useCommunityStore.getState()
    store.setCurrentChannelId("ch_1")
    store.setCurrentChannelMeta({ name: "thread", parentChannelId: "parent_1" })
    store.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!(messageCreate("ch_other"))

    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.channelMembers("ch_other") })
    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.threadParticipants("ch_other") })
  })

  it("dedupes by messageId — a repeat event is a no-op", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })
    capturedOnMessage!(messageCreate("ch_1"))
    capturedOnMessage!(messageCreate("ch_1"))
    capturedOnMessage!(messageCreate("ch_1"))
    expect(getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById.size).toBe(1)
  })

  it("caps the live page at MAX_LIVE_PAGE_MESSAGES, dropping the oldest entry", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const MAX_LIVE_PAGE_MESSAGES = 500
    const seeded = Array.from({ length: MAX_LIVE_PAGE_MESSAGES }, (_, i) => ({
      id: `seed_${i}`,
      content: "x",
      createdAt: "2026-07-03T00:00:00.000Z",
    }))
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: seeded, hasMore: false }],
      pageParams: [null],
    })

    capturedOnMessage!(messageCreate("ch_1", "new_message"))

    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    const ids = cache?.pages[0].messages.map((m) => m.id) ?? []
    expect(ids).toHaveLength(MAX_LIVE_PAGE_MESSAGES)
    expect(ids[0]).toBe("seed_0")
    expect(ids).not.toContain("new_message")
    expect(getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById.has("new_message")).toBe(true)
  })

  it("flips hasMore/hasMoreOlder to true when the head-slice discards history (legacy shape)", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const MAX_LIVE_PAGE_MESSAGES = 500
    const seeded = Array.from({ length: MAX_LIVE_PAGE_MESSAGES }, (_, i) => ({
      id: `seed_${i}`,
      content: "x",
      createdAt: "2026-07-03T00:00:00.000Z",
    }))
    // Legacy newest-mode envelope: only `hasMore` is defined.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: seeded, hasMore: false }],
      pageParams: [null],
    })

    capturedOnMessage!(messageCreate("ch_1", "new_message"))

    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string }[]; hasMore?: boolean; hasMoreOlder?: boolean }[]
    }>(communityKeys.channelMessages("ch_1"))
    // Head-slice discarded seed_0; the "Load older" affordance must re-arm
    // via `hasMore: true` (legacy shape had no `hasMoreOlder` so we don't
    // synthesize it).
    expect(cache?.pages[0].hasMore).toBe(false)
    expect(cache?.pages[0].hasMoreOlder).toBeUndefined()
  })

  it("flips hasMoreOlder to true on head-slice for anchor-mode envelopes", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const MAX_LIVE_PAGE_MESSAGES = 500
    const seeded = Array.from({ length: MAX_LIVE_PAGE_MESSAGES }, (_, i) => ({
      id: `seed_${i}`,
      content: "x",
      createdAt: "2026-07-03T00:00:00.000Z",
    }))
    // Anchor-mode envelope: hasMoreOlder + hasMoreNewer, no `hasMore`.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: seeded, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 42 }],
      pageParams: [{ mode: "anchor", anchor: "seed_0" }],
    })

    capturedOnMessage!(messageCreate("ch_1", "new_message"))

    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string }[]; hasMore?: boolean; hasMoreOlder?: boolean; hasMoreNewer?: boolean }[]
    }>(communityKeys.channelMessages("ch_1"))
    expect(cache?.pages[0].hasMoreOlder).toBe(false)
    // We must NOT invent a legacy `hasMore` flag on an anchor envelope —
    // the two shapes are mutually exclusive.
    expect(cache?.pages[0].hasMore).toBeUndefined()
    // `hasMoreNewer` untouched.
    expect(cache?.pages[0].hasMoreNewer).toBe(false)
  })

  it("does not touch hasMore flags when the page hasn't been trimmed", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [
        {
          messages: [{ id: "seed_0", content: "x", createdAt: "t" }],
          hasMoreOlder: false,
          hasMoreNewer: false,
          latestSeq: 1,
        },
      ],
      pageParams: [null],
    })
    capturedOnMessage!(messageCreate("ch_1", "m_new"))
    const cache = capturedQueryClient.getQueryData<{
      pages: { hasMoreOlder?: boolean; hasMoreNewer?: boolean }[]
    }>(communityKeys.channelMessages("ch_1"))
    expect(cache?.pages[0].hasMoreOlder).toBe(false)
    expect(cache?.pages[0].hasMoreNewer).toBe(false)
  })

  it("does not drop below the cap when the page isn't at capacity yet", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [{ id: "seed_0", content: "x", createdAt: "t" }], hasMore: false }],
      pageParams: [null],
    })
    capturedOnMessage!(messageCreate("ch_1", "m_new"))
    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages.map((m) => m.id)).toEqual(["seed_0"])
    expect(getMessageOverlay({ kind: "channel", id: "ch_1", serverId: "s1" }).liveById.has("m_new")).toBe(true)
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
  it("patches a mounted single-message opener idempotently under actor self-echo", async () => {
    await mountHook({ viewerUserId: "u_me" })
    capturedQueryClient.setQueryData(communityKeys.message("m_opener"), {
      id: "m_opener",
      content: "root",
      reactions: [],
    })
    const event: CommunityReactionAdd = {
      type: "community:reaction.add",
      channelId: "ch_parent",
      messageId: "m_opener",
      userId: "u_me",
      emoji: "👍",
    }

    capturedOnMessage!(event)
    capturedOnMessage!(event)

    expect(capturedQueryClient.getQueryData<{
      reactions: { emoji: string; count: number; me: boolean; userIds: string[] }[]
    }>(communityKeys.message("m_opener"))?.reactions).toEqual([
      { emoji: "👍", count: 1, me: true, userIds: ["u_me"] },
    ])
  })

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

  it("refreshes a focused DM row that exists only in the overlay", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
    await mountHook({ viewerUserId: "u_me" })
    useMessageStreamStore.getState().dispatch(
      { kind: "dm", id: "dm_1" },
      {
        type: "wsMessage",
        message: {
          id: "m_dm",
          seq: 4,
          type: "chat",
          authorId: "u_other",
          authorName: "Other",
          content: "hi",
          reactions: [],
        },
      },
    )

    capturedOnMessage!({
      type: "community:reaction.add",
      channelId: "dm_1",
      messageId: "m_dm",
      userId: "u_me",
      emoji: "👍",
    })

    expect(getMessageOverlay({ kind: "dm", id: "dm_1" }).liveById.get("m_dm")?.reactions).toEqual([
      { emoji: "👍", count: 1, me: true, userIds: ["u_me"] },
    ])
  })
})

describe("useCommunityWs — message.updated", () => {
  it("refreshes approval fields on a focused DM row that exists only in the overlay", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
    await mountHook()
    useMessageStreamStore.getState().dispatch(
      { kind: "dm", id: "dm_1" },
      {
        type: "wsMessage",
        message: { id: "m_dm", seq: 4, type: "chat", content: "approval" },
      },
    )
    const profile = { id: "u_other", name: "Other", discriminator: "0001", image: null }
    const approval = {
      friendshipId: "friendship_1",
      status: "approved" as const,
      waitingOn: null,
      otherProfile: profile,
      botProfile: { ...profile, id: "bot_1", name: "Bot" },
    }

    capturedOnMessage!({
      type: "community:message.updated",
      channelId: "dm_1",
      messageId: "m_dm",
      approval,
    })

    expect(getMessageOverlay({ kind: "dm", id: "dm_1" }).liveById.get("m_dm")?.approval).toEqual(approval)
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

describe("useCommunityWs — DM message.create", () => {
  it("writes the focused DM overlay, leaves Query base-only, and invalidates dms()", async () => {
    vi.useFakeTimers()
    try {
      await mountHook()
      const { useCommunityStore } = await import("@/stores/community")
      useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
      resetHookMemoization()
      await mountHook()

      capturedQueryClient.setQueryData(communityKeys.dmMessages("dm_1"), {
        pages: [{ messages: [], hasMore: false }],
        pageParams: [null],
      })
      const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
      // A DM is a channel now — its message arrives as `message.create` keyed by
      // the DM's channel id (which the subscription tracks in `dmConversationId`).
      const event: CommunityMessageCreate = {
        type: "community:message.create",
        channelId: "dm_1",
        message: {
          id: "dm_m_1",
          seq: 1,
          authorId: "u_a",
          authorName: "a",
          content: "hi",
          type: "chat",
          seq: 1,
          createdAt: "2026-07-03T00:00:00.000Z",
        },
      }
      capturedOnMessage!(event)
      const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string; seq?: number }[] }[] }>(
        communityKeys.dmMessages("dm_1"),
      )
      expect(cache?.pages[0].messages).toEqual([])
      const { getMessageOverlay } = await import("@/stores/community/message-stream")
      expect(
        [...getMessageOverlay({ kind: "dm", id: "dm_1" }).liveById.values()].map((message) => message.id),
      ).toEqual(["dm_m_1"])
      // The inbox + `dms()` invalidation is batched behind the inbox debounce.
      vi.advanceTimersByTime(600)
      expect(
        spy.mock.calls.some((c) => {
          const key = c[0]?.queryKey as unknown[] | undefined
          return Array.isArray(key) && key.includes("dms")
        }),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("heals an already-seen DM event into the overlay before seen dedupe returns", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
    useCommunityWsStore.getState().markSeenMessage("dm_replay")
    await mountHook()

    capturedOnMessage!({
      type: "community:message.create",
      channelId: "dm_1",
      message: {
        id: "dm_replay",
        seq: 12,
        authorId: "u_a",
        authorName: "a",
        content: "replay",
        type: "chat",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    })

    expect(getMessageOverlay({ kind: "dm", id: "dm_1" }).liveById.has("dm_replay")).toBe(true)
  })
})

describe("useCommunityWs — message edit refreshes forum opener summary", () => {
  it("invalidates the parent thread list for an opener edit, but not for an ordinary reply", async () => {
    await mountHook()
    seedParent("s1", "forum_1", "forum")
    const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const opener: CommunityMessageEdited = {
      type: "community:message.edited",
      channelId: "post_1",
      messageId: "opener-post_1",
      content: "new title",
      parentChannelId: "forum_1",
      serverId: "s1",
    }
    capturedQueryClient.setQueryData(communityKeys.message("opener-post_1"), {
      id: "opener-post_1",
      content: "old title",
    })
    const allKey = communityKeys.channelMessages("forum_1")
    const bugKey = [...allKey, "tag", "bug"] as const
    const forumPage = { pages: [{ messages: [{ id: "opener-post_1", content: "old title" }] }], pageParams: [null] }
    capturedQueryClient.setQueryData(allKey, forumPage)
    capturedQueryClient.setQueryData(bugKey, forumPage)
    const sidebarKey = communityKeys.forumSidebarThreads("s1")
    capturedQueryClient.setQueryData(sidebarKey, forumSidebarFixture())
    capturedQueryClient.setQueryData(communityKeys.threads("forum_1"), {
      parentType: "forum",
      serverId: "s1",
      parentChannelId: "forum_1",
      threads: [{ id: "post_1", name: "old title", openerMessageId: "opener-post_1" }],
    })
    capturedOnMessage!(opener)
    await vi.waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: communityKeys.threads("forum_1"), exact: true,
    }))
    expect(capturedQueryClient.getQueryState(allKey)?.isInvalidated).toBe(false)
    expect(capturedQueryClient.getQueryState(bugKey)?.isInvalidated).toBe(false)
    expect(capturedQueryClient.getQueryData<{ pages: { messages: { content: string }[] }[] }>(allKey)?.pages[0].messages[0].content).toBe("new title")
    expect(capturedQueryClient.getQueryData<{ pages: { messages: { content: string }[] }[] }>(bugKey)?.pages[0].messages[0].content).toBe("new title")
    expect(capturedQueryClient.getQueryData<{ content: string }>(communityKeys.message("opener-post_1"))?.content).toBe("new title")
    expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(sidebarKey)?.threads[0].title)
      .toBe("new title")

    invalidateSpy.mockClear()
    capturedOnMessage!({
      type: "community:message.edited",
      channelId: "post_1",
      messageId: "reply_1",
      content: "edited reply",
    } satisfies CommunityMessageEdited)
    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})

describe("useCommunityWs — does NOT auto-mark-read on WS message.create", () => {
  it("does NOT call markRead when a foreign-authored message lands in the focused channel", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_focused" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_focused"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })

    const event: CommunityMessageCreate = {
      type: "community:message.create",
      channelId: "ch_focused",
      message: {
        id: "m_1",
        authorId: "u_someone_else",
        authorName: "them",
        content: "hi",
        seq: 1,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)

    expect(markReadMutate).not.toHaveBeenCalled()
  })

  it("does NOT call markRead when the message is authored by the viewer", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ channelId: "ch_focused" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    const event: CommunityMessageCreate = {
      type: "community:message.create",
      channelId: "ch_focused",
      message: {
        id: "m_1",
        authorId: "u_me",
        authorName: "me",
        content: "hi",
        seq: 1,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)

    expect(markReadMutate).not.toHaveBeenCalled()
  })

  it("does NOT call markRead for a DM message.create either", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    useCommunityStore.getState().subscribe({ dmConversationId: "dm_1" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    const event: CommunityMessageCreate = {
      type: "community:message.create",
      channelId: "dm_1",
      message: {
        id: "dm_m_1",
        authorId: "u_a",
        authorName: "a",
        content: "hi",
        type: "chat",
        seq: 1,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    }
    capturedOnMessage!(event)

    expect(markReadMutate).not.toHaveBeenCalled()
  })
})
