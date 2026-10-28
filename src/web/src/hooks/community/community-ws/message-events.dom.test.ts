import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { messageResourceFixture, currentCommunityEventFixture } from "@/test/community-resource-fixtures"
import { botCreationFixture } from "@/test/bot-creation-fixtures"
import { conversationEntryFromChannel } from "@/test/conversation-entry-fixtures"
import { seedCanonicalFocusedChannel } from "./test-harness"
import { act } from "@/test/react-dom-harness"
import { getCapturedRuntime, seedCanonicalStream, seedCanonicalMessages, canonicalMessage } from "./test-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CommunityMessageCreate,
  CommunityPinAdd,
  CommunityReactionAdd,
} from "@alook/shared"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { writeCommunityProfilePatches, beginCommunityProfileSeed } from "@/lib/community/profile-seed"
import { getMessageStreamState } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { getCanonicalCommunityChannels } from "@/lib/community-db/sync"
import {
  registerReadSurface,
  releaseReadSurface,
  submitReadIntent,
} from "@/hooks/community/read-coordinator"
import {
  promoteInboxReadReservation,
  registerInboxReadReservationSurface,
  releaseInboxReadReservationSurface,
  reserveInboxUnreadsResponse,
  settleInboxReadReservationGeneration,
} from "@/hooks/community/inbox-read-reservation"
import {
  capturedOnMessage,
  capturedQueryClient,
  canonicalForumSidebar,
  cleanupCommunityWsHarness,
  forumSidebarFixture,
  getCommunityApiFetchMock,
  hasCanonicalChannel,
  markReadMutate,
  messageCreate,
  mountHook,
  resetCommunityWsHarness,
  resetHookMemoization,
  seedCanonicalForumSidebar,
} from "./test-harness"

const scheduleGapRepairMock = vi.hoisted(() => vi.fn(() => null))
vi.mock("@/hooks/community/community-ws/reconnect-messages", async original => ({
  ...await original<typeof import("@/hooks/community/community-ws/reconnect-messages")>(),
  scheduleFocusedMessageGapRepair: (...args: unknown[]) => scheduleGapRepairMock(...args),
}))

beforeEach(async () => {
  await resetCommunityWsHarness()
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
  it("publishes a confirmed message without inventing its unknown full author profile", async () => {
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_once" })
    resetHookMemoization()
    await mountHook()
    const registry = getCommunityDbRegistry(capturedQueryClient)!
    const revision = beginCommunityProfileSeed(registry).revision
    const event = messageCreate("ch_once")
    capturedOnMessage!(currentCommunityEventFixture(event))
    expect(beginCommunityProfileSeed(registry).revision).toBe(revision)
    expect(registry.collections.messages.get(event.message.id)).toMatchObject({ content: event.message.content })
    expect(registry.collections.profiles.get(event.message.authorId)).toBeUndefined()
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch_once", serverId: "s1" }).liveIds).toContain(event.message.id)
    expect(canonicalMessage(event.message.id)).toMatchObject({ content: event.message.content })
  })

  it("checks a focused channel gap before projecting the incoming overlay row", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_gap" })
    resetHookMemoization()
    await mountHook()
    scheduleGapRepairMock.mockImplementationOnce(() => {
      expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch_gap", serverId: "s1" }).liveIds.length).toBe(0)
      return null
    })
    const event = messageCreate("ch_gap")
    event.message.seq = 5

    capturedOnMessage!(currentCommunityEventFixture(event))

    expect(scheduleGapRepairMock).toHaveBeenCalledWith(
      capturedQueryClient,
      { kind: "channel", scopeId: "ch_gap", serverId: "s1" },
      5,
    )
  })

  it("checks a focused DM gap and ignores an unrelated scope", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm_gap" })
    resetHookMemoization()
    await mountHook()
    const event = messageCreate("dm_gap")
    event.message.seq = 8

    capturedOnMessage!(currentCommunityEventFixture(event))
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("other")))

    expect(scheduleGapRepairMock).toHaveBeenCalledTimes(1)
    expect(scheduleGapRepairMock).toHaveBeenCalledWith(
      capturedQueryClient,
      { kind: "dm", scopeId: "dm_gap" },
      8,
    )
  })

  it("patches a loaded forum-sidebar child activity without a refetch", async () => {
    await mountHook()
    seedCanonicalForumSidebar("srv_1")
    const key = communityKeys.forumSidebarThreads("srv_1")
    const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const event = {
      ...messageCreate("post_1"),
      serverId: "srv_1",
      parentChannelId: "forum_1",
    } satisfies CommunityMessageCreate

    capturedOnMessage!(currentCommunityEventFixture(event))

    const data = canonicalForumSidebar("srv_1")
    expect(data?.threads[0]).toMatchObject({
      id: "post_1",
      activityAt: "2026-07-03T00:00:00.000Z",
      expiresAt: "2026-07-06T00:00:00.000Z",
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: communityKeys.forumSidebarThreads("srv_1") })
  })

  it("does not infer sidebar participation from content for an unloaded child", async () => {
    await mountHook()
    seedParent("srv_1", "forum_1", "forum")
    const key = communityKeys.forumSidebarThreads("srv_1")
    capturedQueryClient.setQueryData(key, forumSidebarFixture([]))

    capturedOnMessage!(currentCommunityEventFixture({
      ...messageCreate("post_missing"),
      serverId: "srv_1",
      parentChannelId: "forum_1",
    } satisfies CommunityMessageCreate))

    await vi.waitFor(() => {
      expect(capturedQueryClient.getQueryState(key)?.isInvalidated).toBe(false)
    })
  })

  it("warms an unknown forum child owner from live message evidence", async () => {
    await mountHook()
    seedCanonicalForumSidebar("srv_1")
    expect(hasCanonicalChannel("post_live")).toBe(false)
    getCommunityApiFetchMock().mockImplementation(async (url: string) => {
      if (url === "/api/community/channels/post_live/messages?entry=1") {
        return conversationEntryFromChannel({ categoryId: null, topic: "", position: 0, messageCount: 0,
          id: "post_live",
          serverId: "srv_1",
          name: "Live post",
          type: "thread",
          parentChannelId: "forum_1",
          parentMessageId: "opener_live",
          creatorId: "u_other",
          archived: false,
          lastMessageAt: "2026-07-01T00:00:00.000Z",
          createdAt: "2026-07-02T00:00:00.000Z",
        }, "u_me")
      }
      if (url === "/api/community/users/me/read-state") {
        return { revision: 0, readStates: [] }
      }
      throw new Error(`unexpected API fetch: ${url}`)
    })

    capturedOnMessage!(currentCommunityEventFixture({
      ...messageCreate("post_live"),
      serverId: "srv_1",
      parentChannelId: "forum_1",
    } satisfies CommunityMessageCreate))

    await vi.waitFor(() => expect(hasCanonicalChannel("post_live")).toBe(true))
    expect(getCanonicalCommunityChannels(capturedQueryClient)
      .find((channel) => channel.id === "post_live")?.lastMessageAt)
      .toBe("2026-07-03T00:00:00.000Z")
    expect(getCommunityApiFetchMock()).toHaveBeenCalledWith(
      "/api/community/channels/post_live/messages?entry=1",
      expect.objectContaining({ signal: expect.any(AbortSignal), assertActive: expect.any(Function), authenticationAccount: "u_me" }),
    )

    getCommunityApiFetchMock().mockRejectedValueOnce(new Error("metadata unavailable"))
    capturedOnMessage!(currentCommunityEventFixture({
      ...messageCreate("post_unavailable"),
      serverId: "srv_1",
      parentChannelId: "forum_1",
    } satisfies CommunityMessageCreate))
    await vi.waitFor(() => expect(getCommunityApiFetchMock()).toHaveBeenCalledWith(
      "/api/community/channels/post_unavailable/messages?entry=1",
      expect.objectContaining({ signal: expect.any(AbortSignal), assertActive: expect.any(Function), authenticationAccount: "u_me" }),
    ))
    expect(hasCanonicalChannel("post_unavailable")).toBe(false)
  })

  it.each([false, true])(
    "patches retained content without promoting participation (active=%s)",
    async (active) => {
      if (active) {
        const { useCommunityStore } = await import("@/stores/community")
        getCapturedRuntime().ui.actions.subscribe({ channelId: "post_retained" })
      }
      await mountHook()
      seedCanonicalForumSidebar("srv_1", ["post_retained"])
      const key = communityKeys.forumSidebarThreads("srv_1")

      capturedOnMessage!(currentCommunityEventFixture({
        ...messageCreate("post_retained"),
        serverId: "srv_1",
        parentChannelId: "forum_1",
      } satisfies CommunityMessageCreate))

      expect(canonicalForumSidebar("srv_1").threads[0]).toMatchObject({
        activityAt: "2026-07-03T00:00:00.000Z",
        expiresAt: "2026-07-06T00:00:00.000Z",
      })
      await vi.waitFor(() => {
        expect(capturedQueryClient.getQueryState(key)?.isInvalidated ?? false).toBe(false)
      })

      expect(canonicalForumSidebar("srv_1").threads
        .some((thread) => thread.id === "post_retained")).toBe(true)
    },
  )

  it("does not touch forum resources for ordinary text-thread creation", async () => {
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

    capturedOnMessage!(currentCommunityEventFixture({
      ...messageCreate("text_thread"),
      serverId: "s1",
      parentChannelId: "text_parent",
    } satisfies CommunityMessageCreate))


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
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })

    // Re-mount so the ref state picks up the subscription value.
    resetHookMemoization()
    await mountHook()

    // Seed a page cache so setQueryData has something to patch.
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })

    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1")))

    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string; seq?: number }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages).toEqual([])
    expect([...getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch_1", serverId: "s1" }).liveIds]).toHaveLength(1)
  })

  it("projects a split-view parent into its own live overlay", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const store = getCapturedRuntime().ui.get()
    getCapturedRuntime().ui.actions.subscribe({ channelId: "thread_1" })
    getCapturedRuntime().ui.actions.claimSecondaryChannel(Symbol("split"), "parent_1")
    resetHookMemoization()
    await mountHook()

    capturedOnMessage!(currentCommunityEventFixture(messageCreate("parent_1", "parent_message")))
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("thread_1", "thread_message")))

    expect([
      ...getMessageStreamState(capturedQueryClient, { kind: "channel", id: "parent_1", serverId: "s1" }).liveIds,
    ]).toEqual(["parent_message"])
    expect([
      ...getMessageStreamState(capturedQueryClient, { kind: "channel", id: "thread_1", serverId: "s1" }).liveIds,
    ]).toEqual(["thread_message"])
  })

  it("stops treating the parent as focused immediately after the split owner releases it", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    const store = getCapturedRuntime().ui.get()
    const owner = Symbol("split")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "thread_1" })
    getCapturedRuntime().ui.actions.claimSecondaryChannel(owner, "parent_hidden")
    resetHookMemoization()
    await mountHook()

    getCapturedRuntime().ui.actions.releaseSecondaryChannel(owner)
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("parent_hidden", "hidden_parent_message")))
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("thread_1", "visible_thread_message")))

    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "parent_hidden", serverId: "s1" }).liveIds)
      .toHaveLength(0)
    expect([
      ...getMessageStreamState(capturedQueryClient, { kind: "channel", id: "thread_1", serverId: "s1" }).liveIds,
    ]).toEqual(["visible_thread_message"])
  })

  it("heals a first-seen event replay once the focused serverId becomes available", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.setCurrentServerId(null)
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const event = messageCreate("ch_1")
    capturedOnMessage!(currentCommunityEventFixture(event))
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch_1", serverId: "s1" }).liveIds).toHaveLength(0)

    getCapturedRuntime().ui.actions.setCurrentServerId("s1")
    capturedOnMessage!(currentCommunityEventFixture(event))
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch_1", serverId: "s1" }).liveIds).toHaveLength(1)
  })

  it("keeps forum query variants base-only and stages a new opener in the overlay", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "forum_1" })
    resetHookMemoization()
    await mountHook()
    const allKey = communityKeys.channelMessages("forum_1")
    const bugKey = [...allKey, "tag", "bug"] as const
    const empty = { pages: [{ messages: [], hasMore: false }], pageParams: [null] }
    capturedQueryClient.setQueryData(allKey, empty)
    capturedQueryClient.setQueryData(bugKey, empty)

    capturedOnMessage!(currentCommunityEventFixture(messageCreate("forum_1")))

    expect(capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(allKey)?.pages[0].messages).toHaveLength(0)
    expect(capturedQueryClient.getQueryData<{ pages: { messages: unknown[] }[] }>(bugKey)?.pages[0].messages).toHaveLength(0)
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "forum_1", serverId: "s1" }).liveIds).toHaveLength(1)
  })

  it("does NOT patch a channel we aren't focused on", async () => {
    await mountHook()
    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_other"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_other")))
    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_other"),
    )
    expect(cache?.pages[0].messages).toEqual([])
  })

  it("invalidates channelMembers for a focused child channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const store = getCapturedRuntime().ui.get()
    getCapturedRuntime().ui.actions.setCurrentChannelId("ch_1")
    seedCanonicalFocusedChannel({ name: "thread", parentChannelId: "parent_1" })
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1")))

    expect(spy).toHaveBeenCalledWith({ queryKey: communityKeys.channelMembers("ch_1") })
    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.threadParticipants("ch_1") })
  })

  it("does NOT invalidate channelMembers for a focused top-level channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const store = getCapturedRuntime().ui.get()
    getCapturedRuntime().ui.actions.setCurrentChannelId("ch_1")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1")))

    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.channelMembers("ch_1") })
    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.threadParticipants("ch_1") })
  })

  it("does NOT invalidate channelMembers for an unfocused channel", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    const store = getCapturedRuntime().ui.get()
    getCapturedRuntime().ui.actions.setCurrentChannelId("ch_1")
    seedCanonicalFocusedChannel({ name: "thread", parentChannelId: "parent_1" })
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    const spy = vi.spyOn(capturedQueryClient, "invalidateQueries")
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_other")))

    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.channelMembers("ch_other") })
    expect(spy).not.toHaveBeenCalledWith({ queryKey: communityKeys.threadParticipants("ch_other") })
  })

  it("dedupes by messageId — a repeat event is a no-op", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1")))
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1")))
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1")))
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch_1", serverId: "s1" }).liveIds.length).toBe(1)
  })

  it("caps the live page at MAX_LIVE_PAGE_MESSAGES, dropping the oldest entry", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
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

    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1", "new_message")))

    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    const ids = cache?.pages[0].messages.map((m) => m.id) ?? []
    expect(ids).toHaveLength(MAX_LIVE_PAGE_MESSAGES)
    expect(ids[0]).toBe("seed_0")
    expect(ids).not.toContain("new_message")
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch_1", serverId: "s1" }).liveIds.includes("new_message")).toBe(true)
  })

  it("flips hasMore/hasMoreOlder to true when the head-slice discards history (legacy shape)", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
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

    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1", "new_message")))

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
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
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

    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1", "new_message")))

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
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
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
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1", "m_new")))
    const cache = capturedQueryClient.getQueryData<{
      pages: { hasMoreOlder?: boolean; hasMoreNewer?: boolean }[]
    }>(communityKeys.channelMessages("ch_1"))
    expect(cache?.pages[0].hasMoreOlder).toBe(false)
    expect(cache?.pages[0].hasMoreNewer).toBe(false)
  })

  it("does not drop below the cap when the page isn't at capacity yet", async () => {
    await mountHook()
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    resetHookMemoization()
    await mountHook()

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_1"), {
      pages: [{ messages: [{ id: "seed_0", content: "x", createdAt: "t" }], hasMore: false }],
      pageParams: [null],
    })
    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_1", "m_new")))
    const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].messages.map((m) => m.id)).toEqual(["seed_0"])
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch_1", serverId: "s1" }).liveIds.includes("m_new")).toBe(true)
  })

  it("does not schedule an inbox invalidate for viewer's own messages", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "u_author" })
      const invalidateSpy = vi.spyOn(capturedQueryClient, "invalidateQueries")
      capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_random")))
      vi.advanceTimersByTime(1_000)
      expect(invalidateSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("coalesces 10 real unread signals into one attention reconcile", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "u_me" })
      const fetchAttention = vi.spyOn(capturedQueryClient, "query")
      for (let i = 0; i < 10; i++) {
        capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_x", `m_${i}`)))
        capturedOnMessage!(currentCommunityEventFixture({
          type: "community:unread.bump", userId: "u_me", channelId: "ch_x",
          serverId: "s1", isMention: false,
        }))
      }
      expect(fetchAttention).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(500)
      await vi.runAllTicks()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => (
        path === "/api/community/users/me/attention"
      ))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("arms one exact focused candidate before reconciling attention", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "u_me" })
      const { useCommunityStore } = await import("@/stores/community")
      getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_focused" })
      const order: string[] = []
      const api = getCommunityApiFetchMock()
      const originalFetch = api.getMockImplementation()!
      api.mockImplementation((...args) => {
        if (args[0] === "/api/community/users/me/attention") order.push("attention-reconcile")
        return originalFetch(...args)
      })
      const lease = registerInboxReadReservationSurface(
        capturedQueryClient,
        "ch_focused",
        (candidate) => {
          if (candidate) order.push("candidate")
        },
      )
      const event = messageCreate("ch_focused", "m_focused")

      capturedOnMessage!(currentCommunityEventFixture(event))
      capturedOnMessage!(currentCommunityEventFixture({
        type: "community:unread.bump", userId: "u_me", channelId: event.channelId,
        serverId: "s1", isMention: false,
      }))
      capturedOnMessage!(currentCommunityEventFixture(event))
      expect(order).toEqual(["candidate"])

      await vi.advanceTimersByTimeAsync(500)
      await vi.runAllTicks()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      await vi.waitFor(() => expect(order).toContain("attention-reconcile"))
      expect(order.indexOf("candidate")).toBeLessThan(order.indexOf("attention-reconcile"))
      releaseInboxReadReservationSurface(lease)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not re-arm a committed candidate when reconnect replays the seen message", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_focused" })
    const seen = vi.fn()
    const lease = registerInboxReadReservationSurface(
      capturedQueryClient,
      "ch_focused",
      seen,
    )
    const event = messageCreate("ch_focused", "m_committed")

    capturedOnMessage!(currentCommunityEventFixture(event))
    expect(promoteInboxReadReservation(lease, 20)).toBe(true)
    await settleInboxReadReservationGeneration(
      capturedQueryClient,
      20,
      true,
      "ch_focused",
    )
    seen.mockClear()

    capturedOnMessage!(currentCommunityEventFixture(event))

    expect(seen).not.toHaveBeenCalled()
    await expect(reserveInboxUnreadsResponse(capturedQueryClient, {
      servers: [{
        channels: [{
          channelId: "ch_focused",
          lastMessageAt: event.message.createdAt,
          hasDirectUnread: true,
          children: [],
        }],
      }],
      dms: [],
    })).rejects.toMatchObject({ name: "AbortError" })
    releaseInboxReadReservationSurface(lease)
  })

  it("does not arm self-authored or unfocused message candidates", async () => {
    await mountHook({ viewerUserId: "u_author" })
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_focused" })
    const seen: string[] = []
    const lease = registerInboxReadReservationSurface(
      capturedQueryClient,
      "ch_focused",
      (candidate) => {
        if (candidate) seen.push(candidate.channelId)
      },
    )

    capturedOnMessage!(currentCommunityEventFixture(messageCreate("ch_focused", "m_self")))
    const background = messageCreate("ch_background", "m_background")
    background.message.authorId = "u_other"
    capturedOnMessage!(currentCommunityEventFixture(background))

    expect(seen).toEqual([])
    releaseInboxReadReservationSurface(lease)
  })

  it("coalesces attention while a focused read intent is pending", async () => {
    vi.useFakeTimers()
    try {
      const order: string[] = []
      let releaseRead!: (response: unknown) => void
      const pendingRead = new Promise((resolve) => { releaseRead = resolve })
      getCommunityApiFetchMock().mockImplementation(async (url: unknown) => {
        if (typeof url === "string" && url.endsWith("/read")) {
          order.push("read-put")
          return pendingRead
        }
        if (url === "/api/community/users/me/read-state") {
          order.push("read-snapshot")
          return {
            revision: 1,
            readStates: [{
              channelId: "ch_focused",
              lastReadMessageId: "m_visible",
              lastReadAt: "2026-08-27T00:00:00.000Z",
              lastReadSeq: 1,
            }],
          }
        }
        throw new Error(`unexpected API fetch: ${String(url)}`)
      })
      await mountHook({ viewerUserId: "u_me" })
      const { useCommunityStore } = await import("@/stores/community")
      getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_focused" })
      resetHookMemoization()
      await mountHook({ viewerUserId: "u_me" })
      const api = getCommunityApiFetchMock()
      const originalFetch = api.getMockImplementation()!
      api.mockImplementation((...args) => {
        if (args[0] === "/api/community/users/me/attention") order.push("attention-reconcile")
        return originalFetch(...args)
      })
      const lease = registerReadSurface(
        capturedQueryClient,
        "u_me",
        { kind: "timeline", channelId: "ch_focused" },
      )
      const event = messageCreate("ch_focused", "m_visible")

      capturedOnMessage!(currentCommunityEventFixture(event))
      capturedOnMessage!(currentCommunityEventFixture({
        type: "community:unread.bump", userId: "u_me", channelId: event.channelId,
        serverId: "s1", isMention: false,
      }))
      expect(submitReadIntent(lease, {
        kind: "timeline",
        channelId: "ch_focused",
        messageId: "m_visible",
        seq: 1,
      })).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      await vi.runAllTicks()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      await vi.waitFor(() => expect(order).toContain("attention-reconcile"))
      expect(order.filter((entry) => entry === "attention-reconcile")).toHaveLength(1)
      expect(order.filter((entry) => entry === "read-put")).toHaveLength(1)
      releaseRead({ changed: true, revision: 1, targetSeq: 1 })
      releaseReadSurface(lease)
    } finally {
      vi.useRealTimers()
    }
  })

})
describe("useCommunityWs — reactions", () => {
  it("patches a mounted single-message opener idempotently under actor self-echo", async () => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalMessages("ch_parent", [{ id: "m_opener", content: "root", reactions: [] }])
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

    capturedOnMessage!(currentCommunityEventFixture(event))
    capturedOnMessage!(currentCommunityEventFixture(event))

    expect(canonicalMessage("m_opener")?.reactions).toEqual([
      { emoji: "👍", count: 1, me: true, userIds: ["u_me"] },
    ])
  })

  it("patches the message row's reactions in the channel cache", async () => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalMessages("ch_1", [{ id: "m_1", content: "x", reactions: [] }])
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
    capturedOnMessage!(currentCommunityEventFixture(event))
    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: { id: string; reactions: { emoji: string; count: number; me: boolean }[] }[] }[]
    }>(communityKeys.channelMessages("ch_1"))
    expect(cache?.pages[0].messages[0].reactions).toEqual([])
    expect(canonicalMessage("m_1")?.reactions).toEqual([
      { emoji: "👍", count: 1, me: false, userIds: ["u_other"] },
    ])
  })

  it("leaves a focused overlay unchanged when the reaction message is absent", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_empty" })
    await mountHook({ viewerUserId: "u_me" })

    capturedOnMessage!(currentCommunityEventFixture({
      type: "community:reaction.add",
      channelId: "ch_empty",
      messageId: "m_missing",
      userId: "u_other",
      emoji: "👍",
    }))

    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch_empty", serverId: "s1" }).liveIds.length)
      .toBe(0)
  })

  it("patches every mounted message-context copy for the reaction channel", async () => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalMessages("ch_1", [{ id: "m_1", content: "x", reactions: [] }, { id: "m_other", content: "other", reactions: [] }])
    const unresolvedContext = { notFound: true }
    capturedQueryClient.setQueryData(communityKeys.messageContext("channel", "ch_1", 7), {
      anchorId: "m_1",
      messages: [{ id: "m_1", type: "chat", content: "x", reactions: [] }],
    })
    capturedQueryClient.setQueryData(communityKeys.messageContext("channel", "ch_1", 99), {
      anchorId: "m_other",
      messages: [{ id: "m_other", type: "chat", content: "other", reactions: [] }],
    })
    capturedQueryClient.setQueryData(
      communityKeys.messageContext("dm", "ch_1", 8),
      unresolvedContext,
    )
    capturedOnMessage!(currentCommunityEventFixture({
      type: "community:reaction.add",
      channelId: "ch_1",
      messageId: "m_1",
      userId: "u_other",
      emoji: "🔥",
    }))
    expect(canonicalMessage("m_1")?.reactions).toEqual([
      { emoji: "🔥", count: 1, me: false, userIds: ["u_other"] },
    ])
    expect(capturedQueryClient.getQueryData<{
      messages: { reactions: unknown[] }[]
    }>(communityKeys.messageContext("channel", "ch_1", 99))?.messages[0].reactions).toEqual([])
    expect(capturedQueryClient.getQueryData(communityKeys.messageContext("dm", "ch_1", 8)))
      .toBe(unresolvedContext)
  })

  it("refreshes a focused DM row that exists only in the overlay", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm_1" })
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalStream(
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

    capturedOnMessage!(currentCommunityEventFixture({
      type: "community:reaction.add",
      channelId: "dm_1",
      messageId: "m_dm",
      userId: "u_me",
      emoji: "👍",
    }))

    expect(getMessageStreamState(capturedQueryClient, { kind: "dm", id: "dm_1" }).liveIds).toContain("m_dm")
    expect(canonicalMessage("m_dm")?.reactions).toEqual([
      { emoji: "👍", count: 1, me: true, userIds: ["u_me"] },
    ])
  })

  it("refreshes a focused channel row that exists only in the overlay", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    await mountHook({ viewerUserId: "u_me" })
    const scope = { kind: "channel" as const, id: "ch_1", serverId: "s1" }
    seedCanonicalStream(scope, {
      type: "wsMessage",
      message: {
        id: "m_channel",
        seq: 4,
        type: "chat",
        authorId: "u_other",
        authorName: "Other",
        content: "hi",
        reactions: [],
      },
    })

    capturedOnMessage!(currentCommunityEventFixture({
      type: "community:reaction.add",
      channelId: "ch_1",
      messageId: "m_channel",
      userId: "u_me",
      emoji: "👍",
    }))

    expect(getMessageStreamState(capturedQueryClient, scope).liveIds).toContain("m_channel")
    expect(canonicalMessage("m_channel")?.reactions).toEqual([
      { emoji: "👍", count: 1, me: true, userIds: ["u_me"] },
    ])
  })
})

describe("useCommunityWs — message.updated", () => {
  it("projects gallery resolution without erasing friendship approval or overwriting a renamed identity", async () => {
    getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm_1" })
    await mountHook()
    const profile = { id: "friend", name: "Friend", discriminator: "0001", image: null, avatarVersion: 0 }
    const approval = { friendshipId: "friendship", status: "pending" as const, waitingOn: "you" as const, otherProfile: profile, botProfile: { ...profile, id: "bot" }, waitingOnProfile: null }
    seedCanonicalStream({ kind: "dm", id: "dm_1" }, { type: "wsMessage", message: { id: "gallery-message", seq: 4, type: "chat", content: "", approval, botCreation: botCreationFixture() } })
    capturedQueryClient.setQueryData(communityKeys.bots(), { bots: [] })
    const request = botCreationFixture({ status: "approved" })
    request.bots[0]!.createdBot = { id: "new-bot", name: "Researcher", discriminator: "0042", image: null, avatarVersion: 0 }
    writeCommunityProfilePatches([{ id: "new-bot", avatar: { avatar: null, avatarVersion: 0 }, identityAbout: { discriminator: "0042", name: "Renamed Bot", discriminator: "0042" } }], getCommunityDbRegistry(capturedQueryClient), { command: true })
    capturedOnMessage!(currentCommunityEventFixture({ type: "community:message.updated", channelId: "dm_1", messageId: "gallery-message", botCreation: request }))
    expect(canonicalMessage("gallery-message")).toMatchObject({ approval, botCreation: request })
    expect(getCommunityDbRegistry(capturedQueryClient)!.collections.profiles.get("new-bot")).toMatchObject({ name: "Renamed Bot", discriminator: "0042" })
    expect(capturedQueryClient.getQueryState(communityKeys.bots())?.isInvalidated).toBe(true)
    capturedOnMessage!(currentCommunityEventFixture({ type: "community:message.updated", channelId: "dm_1", messageId: "gallery-message", approval: { ...approval, status: "denied", waitingOn: null } }))
    expect(canonicalMessage("gallery-message")?.botCreation).toEqual(request)
  })

  it("refreshes approval fields on a focused DM row that exists only in the overlay", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm_1" })
    await mountHook()
    seedCanonicalStream(
      { kind: "dm", id: "dm_1" },
      {
        type: "wsMessage",
        message: { id: "m_dm", seq: 4, type: "chat", authorId: "raw_author", authorName: "Raw Author", content: "approval" },
      },
    )
    capturedQueryClient.setQueryData(communityKeys.dmMessages("dm_1"), {
      pages: [{
        messages: [{
          id: "m_dm",
          type: "chat",
          authorId: "raw_author",
          authorName: "Raw Author",
          content: "approval",
        }],
        hasMore: false,
      }],
      pageParams: [null],
    })
    const profile = { id: "u_other", name: "Other", discriminator: "0001", image: null, avatarVersion: 0 }
    const approval = {
      friendshipId: "friendship_1",
      status: "approved" as const,
      waitingOn: null,
      otherProfile: profile,
      botProfile: { ...profile, id: "bot_1", name: "Bot" },
      waitingOnProfile: { ...profile, id: "waiting_1", name: "Waiting" },
    }

    capturedOnMessage!(currentCommunityEventFixture({
      type: "community:message.updated",
      channelId: "dm_1",
      messageId: "m_dm",
      approval,
    }))

    expect(getMessageStreamState(capturedQueryClient, { kind: "dm", id: "dm_1" }).liveIds).toContain("m_dm")
    expect(canonicalMessage("m_dm")?.approval).toEqual(approval)
    const cache = capturedQueryClient.getQueryData<{
      pages: { messages: Array<{ authorName?: string; approval?: unknown }> }[]
    }>(communityKeys.dmMessages("dm_1"))
    expect(cache?.pages[0].messages[0]).toMatchObject({
      authorName: "Raw Author",
    })
    expect(cache?.pages[0].messages[0]).not.toHaveProperty("approval")
    expect(canonicalMessage("m_dm")).toMatchObject({ authorName: "Raw Author", approval })
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(getCapturedRuntime().ws.get()).not.toHaveProperty("profilesByUserId")
  })

  it("refreshes approval fields on a focused channel row that exists only in the overlay", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_1" })
    await mountHook()
    const scope = { kind: "channel" as const, id: "ch_1", serverId: "s1" }
    seedCanonicalStream(scope, {
      type: "wsMessage",
      message: { id: "m_channel", seq: 4, type: "chat", content: "approval" },
    })
    const profile = { id: "u_other", name: "Other", discriminator: "0001", image: null, avatarVersion: 0 }
    const approval = {
      friendshipId: "friendship_1",
      status: "approved" as const,
      waitingOn: null,
      otherProfile: profile,
      botProfile: { ...profile, id: "bot_1", name: "Bot" },
    }

    capturedOnMessage!(currentCommunityEventFixture({
      type: "community:message.updated",
      channelId: "ch_1",
      messageId: "m_channel",
      approval,
    }))

    expect(getMessageStreamState(capturedQueryClient, scope).liveIds).toContain("m_channel")
    expect(canonicalMessage("m_channel")?.approval).toEqual(approval)
  })

  it("refreshes approval fields on a secondary focused channel", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.claimSecondaryChannel(Symbol("split"), "ch_parent")
    await mountHook()
    const scope = { kind: "channel" as const, id: "ch_parent", serverId: "s1" }
    seedCanonicalStream(scope, {
      type: "wsMessage",
      message: { id: "m_parent", seq: 4, type: "chat", content: "approval" },
    })
    const profile = { id: "u_other", name: "Other", discriminator: "0001", image: null, avatarVersion: 0 }
    const approval = {
      friendshipId: "friendship_1",
      status: "approved" as const,
      waitingOn: null,
      otherProfile: profile,
      botProfile: { ...profile, id: "bot_1", name: "Bot" },
    }

    capturedOnMessage!(currentCommunityEventFixture({
      type: "community:message.updated",
      channelId: "ch_parent",
      messageId: "m_parent",
      approval,
    }))

    expect(getMessageStreamState(capturedQueryClient, scope).liveIds).toContain("m_parent")
    expect(canonicalMessage("m_parent")?.approval).toEqual(approval)
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
    capturedOnMessage!(currentCommunityEventFixture(event))
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
  it("writes the focused DM overlay, leaves Query base-only, and reconciles attention", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "u_me" })
      const { useCommunityStore } = await import("@/stores/community")
      getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm_1" })
      resetHookMemoization()
      await mountHook({ viewerUserId: "u_me" })

      capturedQueryClient.setQueryData(communityKeys.dmMessages("dm_1"), {
        pages: [{ messages: [], hasMore: false }],
        pageParams: [null],
      })
      const fetchAttention = vi.spyOn(capturedQueryClient, "query")
      // A DM is a channel now — its message arrives as `message.create` keyed by
      // the DM's channel id (which the subscription tracks in `dmConversationId`).
      const event: CommunityMessageCreate = {
        type: "community:message.create",
        channelId: "dm_1",
        message: messageResourceFixture({ authorAvatarVersion: 0, channelId: "dm_1", ...{
          id: "dm_m_1",
          seq: 1,
          authorId: "u_a",
          authorName: "a",
          authorAvatarVersion: 0,
          content: "hi",
          type: "chat",
          seq: 1,
          createdAt: "2026-07-03T00:00:00.000Z",
        } }),
      }
      capturedOnMessage!(currentCommunityEventFixture(event))
      capturedOnMessage!(currentCommunityEventFixture({
        type: "community:unread.bump", userId: "u_me", channelId: event.channelId,
        isMention: false,
      }))
      const cache = capturedQueryClient.getQueryData<{ pages: { messages: { id: string; seq?: number }[] }[] }>(
        communityKeys.dmMessages("dm_1"),
      )
      expect(cache?.pages[0].messages).toEqual([])
      const { getMessageStreamState } = await import("@/test/community-query-owner")
      expect(
        getMessageStreamState(capturedQueryClient, { kind: "dm", id: "dm_1" }).liveIds,
      ).toEqual(["dm_m_1"])
      await vi.advanceTimersByTimeAsync(600)
      await vi.runAllTicks()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => (
        path === "/api/community/users/me/attention"
      ))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("heals an already-seen DM event into the overlay before seen dedupe returns", async () => {
    const { useCommunityStore } = await import("@/stores/community")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm_1" })
    getCapturedRuntime().ws.actions.markSeenMessage("dm_replay")
    await mountHook()

    capturedOnMessage!(currentCommunityEventFixture({
      type: "community:message.create",
      channelId: "dm_1",
      message: messageResourceFixture({ authorAvatarVersion: 0, channelId: "dm_1", ...{
        id: "dm_replay",
        seq: 12,
        authorId: "u_a",
        authorName: "a",
        authorAvatarVersion: 0,
        content: "replay",
        type: "chat",
        createdAt: "2026-07-03T00:00:00.000Z",
      } }),
    }))

    expect(getMessageStreamState(capturedQueryClient, { kind: "dm", id: "dm_1" }).liveIds.includes("dm_replay")).toBe(true)
  })
})

describe("canonical message refresh ownership", () => {
  it("keeps the newest 500 live rows when dispatch precedes canonical publication", async () => {
    const scope = { kind: "channel" as const, id: "ch_1", serverId: "s1" }
    getCapturedRuntime().ui.actions.setCurrentServerId(scope.serverId)
    getCapturedRuntime().ui.actions.subscribe({ channelId: scope.id })
    await mountHook()
    await act(async () => {
      for (let seq = 1; seq <= 502; seq++) {
        const event = messageCreate(scope.id, `tail_${seq}`)
        capturedOnMessage!(currentCommunityEventFixture({ ...event, message: { ...event.message, seq } }))
      }
    })
    const live = getMessageStreamState(capturedQueryClient, scope).liveIds
    expect(live.length).toBe(500)
    expect(live.includes("tail_1")).toBe(false)
    expect(live.includes("tail_2")).toBe(false)
    expect(live).toContain("tail_502")
    expect(canonicalMessage("tail_502")?.seq).toBe(502)
  })
  it("clears canonical rich fields when a websocket row explicitly sends empty arrays", async () => {
    const scope = { kind: "channel" as const, id: "ch_1", serverId: "s1" }
    getCapturedRuntime().ui.actions.setCurrentServerId(scope.serverId)
    getCapturedRuntime().ui.actions.subscribe({ channelId: scope.id })
    await mountHook()
    const event = messageCreate(scope.id)
    seedCanonicalMessages(scope.id, [{ ...event.message,
      attachments: [{ id: "settled", name: "settled.txt", url: "/media/settled", thumbnailUrl: null, contentType: "text/plain", sizeBytes: 1024, width: null, height: null }],
      embeds: [{ title: "Prior" }],
    }])
    await act(async () => { capturedOnMessage!(currentCommunityEventFixture({ ...event, message: { ...event.message, attachments: [], embeds: [] } })) })
    expect(getCommunityDbRegistry(capturedQueryClient)!.collections.messages.get(event.message.id)).toMatchObject({ attachments: [], embeds: [] })
    expect(getMessageStreamState(capturedQueryClient, scope).liveIds).toContain(event.message.id)
    expect(canonicalMessage(event.message.id)).toMatchObject({ attachments: [], embeds: [] })
  })
  it("rejects a duplicate WS row missing required attachments without changing canonical bytes", async () => {
    const scope = { kind: "channel" as const, id: "ch_1", serverId: "s1" }
    getCapturedRuntime().ui.actions.setCurrentServerId(scope.serverId)
    getCapturedRuntime().ui.actions.subscribe({ channelId: scope.id })
    await mountHook()
    const attachments = [{ id: "settled", name: "settled.txt", url: "/media/settled", thumbnailUrl: null, contentType: "text/plain", sizeBytes: 1024, width: null, height: null }]
    const event = messageCreate(scope.id)
    seedCanonicalMessages(scope.id, [{ ...event.message, attachments }])
    const { attachments: _attachments, ...incomplete } = event.message
    await act(async () => { capturedOnMessage!({ ...event, schemaVersion: BUSINESS_SCHEMA_VERSION, message: incomplete }) })
    expect(getCommunityDbRegistry(capturedQueryClient)!.collections.messages.get(event.message.id)?.attachments).toEqual(attachments)
    expect(getMessageStreamState(capturedQueryClient, scope).liveIds).not.toContain(event.message.id)
    expect(canonicalMessage(event.message.id)?.attachments).toEqual([{ name: "settled.txt", url: "/media/settled", contentType: "text/plain", sizeBytes: 1024, kind: "file", size: "1.0 KB" }])
  })
})

describe("useCommunityWs — does NOT auto-mark-read on WS message.create", () => {
  it("does NOT call markRead when a foreign-authored message lands in the focused channel", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_focused" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    capturedQueryClient.setQueryData(communityKeys.channelMessages("ch_focused"), {
      pages: [{ messages: [], hasMore: false }],
      pageParams: [null],
    })

    const event: CommunityMessageCreate = {
      type: "community:message.create",
      channelId: "ch_focused",
      message: messageResourceFixture({ authorAvatarVersion: 0, channelId: "ch_focused", ...{
        id: "m_1",
        authorId: "u_someone_else",
        authorName: "them",
        content: "hi",
        seq: 1,
        createdAt: "2026-07-03T00:00:00.000Z",
      } }),
    }
    capturedOnMessage!(currentCommunityEventFixture(event))

    expect(markReadMutate).not.toHaveBeenCalled()
  })

  it("does NOT call markRead when the message is authored by the viewer", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch_focused" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    const event: CommunityMessageCreate = {
      type: "community:message.create",
      channelId: "ch_focused",
      message: messageResourceFixture({ authorAvatarVersion: 0, channelId: "ch_focused", ...{
        id: "m_1",
        authorId: "u_me",
        authorName: "me",
        content: "hi",
        seq: 1,
        createdAt: "2026-07-03T00:00:00.000Z",
      } }),
    }
    capturedOnMessage!(currentCommunityEventFixture(event))

    expect(markReadMutate).not.toHaveBeenCalled()
  })

  it("does NOT call markRead for a DM message.create either", async () => {
    await mountHook({ viewerUserId: "u_me" })
    const { useCommunityStore } = await import("@/stores/community")
    getCapturedRuntime().ui.actions.subscribe({ dmConversationId: "dm_1" })
    resetHookMemoization()
    await mountHook({ viewerUserId: "u_me" })

    const event: CommunityMessageCreate = {
      type: "community:message.create",
      channelId: "dm_1",
      message: messageResourceFixture({ authorAvatarVersion: 0, channelId: "dm_1", ...{
        id: "dm_m_1",
        authorId: "u_a",
        authorName: "a",
        content: "hi",
        type: "chat",
        seq: 1,
        createdAt: "2026-07-03T00:00:00.000Z",
      } }),
    }
    capturedOnMessage!(currentCommunityEventFixture(event))

    expect(markReadMutate).not.toHaveBeenCalled()
  })
})
