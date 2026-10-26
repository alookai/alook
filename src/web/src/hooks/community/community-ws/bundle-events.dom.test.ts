import { conversationEntryFromChannel, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { act } from "@/test/react-dom-harness"
import { getCapturedRuntime, seedCanonicalStream, canonicalMessage } from "./test-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES,
  COMMUNITY_BROWSER_EVENT_BATCH_TYPE,
  deriveCommunityDeliveryOperationId,
  encodeCommunityBrowserEventBatch,
  encodeCommunityBrowserEventBatchForContract,
  prepareCommunityDeliveryEvents,
  type CommunityWsEvent,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"

const reconcileCommunityWsReconnect = vi.hoisted(() => vi.fn(async () => ({
  policyCount: 13,
  successCount: 13,
  failureCount: 0,
})))

vi.mock("./reconnect", () => ({ reconcileCommunityWsReconnect }))

import {
  capturedOnMessage,
  capturedQueryClient,
  canonicalForumSidebar,
  cleanupCommunityWsHarness,
  forumSidebarFixture,
  getCommunityApiFetchMock,
  hasCanonicalChannelAccess,
  hasCanonicalChannelNotify,
  mountHook,
  resetCommunityWsHarness,
  seedCanonicalForumSidebar,
  seedCanonicalThread,
} from "./test-harness"
import { getCanonicalCommunityChannels, getCanonicalCommunityMessages } from "@/lib/community-db/sync"
import * as canonicalSync from "@/lib/community-db/sync"
import { useCommunityStore } from "@/stores/community"
import { getMessageStreamState } from "@/test/community-query-owner"
import {
  SEEN_DELIVERY_OPERATION_MAX,
  SEEN_DELIVERY_OPERATION_TRIM_TO,
} from "@/stores/community/ws"
import {
  registerReadSurface,
  releaseReadSurface,
  submitReadIntent,
} from "@/hooks/community/read-coordinator"

beforeEach(async () => {
  reconcileCommunityWsReconnect.mockClear()
  await resetCommunityWsHarness()
})
afterEach(cleanupCommunityWsHarness)

const message = {
  type: "community:message.create" as const,
  channelId: "ch-1",
  serverId: "server-1",
  message: {
    id: "message-1",
    seq: 1,
    authorId: "author-1",
    authorName: "Alice",
    authorAvatarVersion: 0,
    content: "hello",
    type: "chat" as const,
    createdAt: "2026-08-21T00:00:00.000Z",
  },
}
const mentionEvents: CommunityWsEvent[] = [
  message,
  {
    type: "community:unread.bump",
    userId: "viewer-1",
    channelId: "ch-1",
    serverId: "server-1",
    railChannelId: "ch-1",
    isMention: true,
  },
  {
    type: "community:mention.create",
    userId: "viewer-1",
    messageId: "message-1",
    channelId: "ch-1",
    authorName: "Alice",
  },
]

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

function invalidationCount(queryKey: readonly unknown[]): number {
  return vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.filter(([filters]) =>
    JSON.stringify(filters.queryKey) === JSON.stringify(queryKey)).length
}

function attentionReconcileCount(): number {
  return getCommunityApiFetchMock().mock.calls.filter(([path]) => (
    path === "/api/community/users/me/attention"
  )).length
}

describe("useCommunityWs — operation bundles", () => {
  it("admits a v2 batch only after its exact wire digest verifies", async () => {
    await mountHook()
    const prepared = await prepareCommunityDeliveryEvents([message])
    if (!prepared.ok) throw new Error("Invalid test event")
    const frame = await encodeCommunityBrowserEventBatchForContract({ operationId: await deriveCommunityDeliveryOperationId("v2-wire"), prepared: prepared.prepared, contract: 2 })
    if (!frame.ok) throw new Error("Invalid test batch")
    const tampered = JSON.parse(frame.body)
    tampered.events[0].message.content = "changed after encoding"
    await act(async () => { await capturedOnMessage!(tampered) })
    expect(getCapturedRuntime().ws.get().seenMessageIds.size).toBe(0)
    expect(canonicalMessage(message.message.id)).toBeUndefined()
    await act(async () => { await capturedOnMessage!(frame.batch) })
    expect(canonicalMessage(message.message.id)?.content).toBe("hello")
    expect(getCapturedRuntime().ws.get().seenDeliveryOperations.get(frame.batch.operationId)).toEqual({ digest: prepared.prepared.digest, completed: true })
  })

  it.each(["socket", "account"] as const)("drops a verified batch after original %s retirement during hashing", async (owner) => {
    await mountHook()
    const prepared = await prepareCommunityDeliveryEvents([message])
    if (!prepared.ok) throw new Error("Invalid test event")
    const frame = await encodeCommunityBrowserEventBatchForContract({ operationId: await deriveCommunityDeliveryOperationId("v2-retired"), prepared: prepared.prepared, contract: 2 })
    if (!frame.ok) throw new Error("Invalid test batch")
    let release!: () => void
    let retired = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const hashing = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => { await gate; return digest(algorithm, data) })
    try {
      const pending = capturedOnMessage!(frame.batch, () => { if (retired) throw new DOMException("Retired socket", "AbortError") })
      expect(getCapturedRuntime().ws.get().seenMessageIds.size).toBe(0)
      await act(async () => {
        if (owner === "socket") retired = true
        else getCapturedRuntime().ws.actions.activateProfileAccount("other")
        release()
        await pending
      })
      expect(canonicalMessage(message.message.id)).toBeUndefined()
      expect(getCapturedRuntime().ws.get().seenDeliveryOperations.size).toBe(0)
    } finally { hashing.mockRestore() }
  })

  it("applies archive and null-tag sidebar semantics inside committed batches", async () => {
    await mountHook()
    const baseKey = communityKeys.forumSidebarThreads("s1")
    seedCanonicalForumSidebar("s1", ["post_1", "post_2"])

    capturedOnMessage!(await batchFor("forum-archive", [{
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "post_1",
      changes: { tags: ["archived"] },
    }]))

    expect(canonicalForumSidebar("s1").threads.map(({ id }) => id)).toEqual(["post_2"])
    expect(getCanonicalCommunityChannels(capturedQueryClient)
      .find(({ id }) => id === "post_1")).toMatchObject({ archived: false })
    expect(hasCanonicalChannelAccess("post_1", "u_me")).toBe(true)
    expect(hasCanonicalChannelNotify("post_1", "u_me")).toBe(false)
    expect(getCanonicalCommunityMessages(capturedQueryClient)
      .find(({ id }) => id === "opener-post_1")).toMatchObject({ content: "title-post_1" })
    capturedOnMessage!(await batchFor("forum-unarchive", [{
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "post_1",
      changes: { tags: null },
    }]))

    expect(canonicalForumSidebar("s1").threads.map(({ id }) => id).sort())
      .toEqual(["post_1", "post_2"])
    expect(getCanonicalCommunityChannels(capturedQueryClient)
      .find(({ id }) => id === "post_1")).toMatchObject({ archived: false })
    expect(hasCanonicalChannelNotify("post_1", "u_me")).toBe(true)
  })

  it("decodes all children before one dispatch, deduplicates invalidations, and suppresses same-digest replay", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "viewer-1" })
      capturedQueryClient.setQueryData(communityKeys.servers(), {
        servers: [{ id: "server-1", mentions: 5 }],
      })
      vi.spyOn(capturedQueryClient, "invalidateQueries")
      vi.spyOn(capturedQueryClient, "query")
      const frame = await batchFor("message-1", mentionEvents)

      capturedOnMessage!(frame)
      expect(capturedQueryClient.getQueryData<{ servers: Array<{ id: string; mentions: number }> }>(
        communityKeys.servers(),
      )?.servers[0]?.mentions).toBe(5)
      expect(attentionReconcileCount()).toBe(0)
      expect(invalidationCount(communityKeys.servers())).toBe(0)
      await vi.advanceTimersByTimeAsync(500)
      expect(attentionReconcileCount()).toBe(1)

      const callsAfterFirst = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length
      capturedOnMessage!(frame)
      await vi.advanceTimersByTimeAsync(500)
      expect(vi.mocked(capturedQueryClient.invalidateQueries)).toHaveBeenCalledTimes(callsAfterFirst)
      expect(attentionReconcileCount()).toBe(1)
      const { useCommunityWsStore } = await import("@/stores/community/ws")
      expect(getCapturedRuntime().ws.get().seenDeliveryOperations.get(frame.operationId))
        .toEqual({ digest: frame.operationDigest, completed: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not invent attention from an ambiguous same-channel bundle", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    const frame = await batchFor("ambiguous-bump", [
      { ...message, message: { ...message.message, id: "ambiguous-1", seq: 1 } },
      { ...message, message: { ...message.message, id: "ambiguous-2", seq: 2 } },
      mentionEvents[1]!,
    ])
    capturedOnMessage!(frame)
  })

  it("keeps content and refreshes attention regardless of child order", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    const frame = await batchFor("reordered-bump", [
      mentionEvents[1]!,
      mentionEvents[2]!,
      mentionEvents[0]!,
    ])
    capturedOnMessage!(frame)
  })

  it("does not invent attention from a different mention message id", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    const frame = await batchFor("mismatched-mention", [
      message,
      {
        type: "community:mention.create",
        userId: "viewer-1",
        messageId: "different-message",
        channelId: "ch-1",
        authorName: "Alice",
      },
    ])
    capturedOnMessage!(frame)
  })

  it("does not cancel or restart an in-flight raw server resource for a projected bump", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    const key = communityKeys.servers()
    capturedQueryClient.setQueryData(key, {
      servers: [{ id: "server-1", unread: false, mentions: 5 }],
    })
    let queryCalls = 0
    const queryFn = ({ signal }: { signal: AbortSignal }) => {
      queryCalls += 1
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"))
        }, { once: true })
      })
    }
    const first = capturedQueryClient.query({ queryKey: key, queryFn, staleTime: 0 })
      .catch(() => undefined)
    await vi.waitFor(() => expect(queryCalls).toBe(1))
    const cancel = vi.spyOn(capturedQueryClient, "cancelQueries")

    capturedOnMessage!(await batchFor("message-fenced-mention", mentionEvents))

    expect(queryCalls).toBe(1)
    expect(cancel.mock.calls.filter(([filters]) => JSON.stringify(filters.queryKey) === JSON.stringify(key))).toEqual([])
    await capturedQueryClient.cancelQueries({ queryKey: key, exact: true })
    await first
  })

  it("treats repair-then-late-bundle mention state as authoritative invalidation, never arithmetic", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "viewer-1" })
      const { useCommunityWsStore } = await import("@/stores/community/ws")
      getCapturedRuntime().ws.actions.markSeenMessage(message.message.id)
      capturedQueryClient.setQueryData(communityKeys.servers(), {
        servers: [{ id: "server-1", mentions: 9 }],
      })
      vi.spyOn(capturedQueryClient, "invalidateQueries")
      vi.spyOn(capturedQueryClient, "query")

      capturedOnMessage!(await batchFor("message-late", mentionEvents))
      expect(capturedQueryClient.getQueryData<{ servers: Array<{ mentions: number }> }>(
        communityKeys.servers(),
      )?.servers[0]?.mentions).toBe(9)
      expect(attentionReconcileCount()).toBe(0)
      expect(invalidationCount(communityKeys.servers())).toBe(0)
      await vi.advanceTimersByTimeAsync(500)
      expect(attentionReconcileCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects malformed children without poisoning the operation map", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    const frame = await batchFor("message-malformed", mentionEvents)
    capturedOnMessage!({
      ...frame,
      events: [{ ...frame.events[0], contractVersion: 1 }, ...frame.events.slice(1)],
    })

    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(getCapturedRuntime().ws.get().seenDeliveryOperations.size).toBe(0)
    expect(reconcileCommunityWsReconnect).not.toHaveBeenCalled()
  })

  it("reports bounded metadata for oversized and invalid batch or single frames", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await mountHook({ viewerUserId: "viewer-1" })

    capturedOnMessage!({
      type: COMMUNITY_BROWSER_EVENT_BATCH_TYPE,
      padding: "x".repeat(COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES),
    })
    capturedOnMessage!({
      type: COMMUNITY_BROWSER_EVENT_BATCH_TYPE,
      extra: true,
    })
    capturedOnMessage!({ ...message, contractVersion: 1 })

    expect(warn).toHaveBeenCalledWith(
      "[ws] frame dropped",
      expect.objectContaining({ reason: "oversized" }),
    )
    expect(warn).toHaveBeenCalledWith(
      "[ws] frame dropped",
      expect.objectContaining({ reason: "invalid-payload", type: COMMUNITY_BROWSER_EVENT_BATCH_TYPE }),
    )
    expect(warn).toHaveBeenCalledWith(
      "[ws] frame dropped",
      expect.objectContaining({ reason: "invalid-payload", type: "community:message.create" }),
    )
  })

  it("rejects same-ID/different-digest before projection and reconciles once", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch-1" })
    vi.spyOn(capturedQueryClient, "invalidateQueries")
    const first = await batchFor("message-conflict", mentionEvents)
    const conflicting = await batchFor("message-conflict", [
      { ...message, message: { ...message.message, content: "different" } },
    ])
    capturedOnMessage!(first)
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const seenMessages = getCapturedRuntime().ws.get().seenMessageIds.size
    const overlayBeforeConflict = getMessageStreamState(capturedQueryClient, {
      kind: "channel",
      id: "ch-1",
      serverId: "s1",
    })
    const invalidationsBeforeConflict = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length

    capturedOnMessage!(conflicting)
    expect(getCapturedRuntime().ws.get().seenMessageIds.size).toBe(seenMessages)
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch-1", serverId: "s1" }))
      .toStrictEqual(overlayBeforeConflict)
    expect(vi.mocked(capturedQueryClient.invalidateQueries))
      .toHaveBeenCalledTimes(invalidationsBeforeConflict)
    expect(getCapturedRuntime().ws.get().seenDeliveryOperations.get(first.operationId))
      .toEqual({ digest: first.operationDigest, completed: true })
    expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(1)
  })

  it("locks the digest across a second-child fault, rejects conflict, then completes replay", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch-1" })
    capturedQueryClient.setQueryData(communityKeys.server("s1"), {
      id: "s1",
      categories: [{
        id: "category-1",
        channels: [{ id: "text-parent", type: "text", unread: false }],
      }],
    })
    const originalProject = canonicalSync.projectCommunityWsEventToDb
    let fail = true
    const recordArrival = vi.spyOn(canonicalSync, "projectCommunityWsEventToDb").mockImplementation((...args) => {
      if (fail && args[1].type === "community:unread.bump") { fail = false; throw new Error("second-child fault") }
      return originalProject(...args)
    })
    vi.spyOn(capturedQueryClient, "invalidateQueries")
    const events: CommunityWsEvent[] = [
      {
        ...message,
        serverId: "s1",
        parentChannelId: "text-parent",
        message: { ...message.message, id: "message-before-second-child-fault" },
      },
      {
        type: "community:unread.bump",
        userId: "viewer-1",
        channelId: "ch-1",
        serverId: "s1",
        railChannelId: "text-parent",
        isMention: false,
      },
    ]
    const frame = await batchFor("message-second-child-fault", events)
    const conflicting = await batchFor("message-second-child-fault", [
      {
        ...events[0]!,
        message: { ...message.message, id: "message-before-second-child-fault", content: "tampered" },
      } as CommunityWsEvent,
      events[1]!,
    ])

    capturedOnMessage!(frame)
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(1)
    expect(getCapturedRuntime().ws.get().seenDeliveryOperations.get(frame.operationId))
      .toEqual({ digest: frame.operationDigest, completed: false })
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch-1", serverId: "s1" }).liveIds.includes("message-before-second-child-fault")).toBe(true)

    recordArrival.mockRestore()
    const invalidationsAfterFailure = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length
    capturedOnMessage!(conflicting)
    expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(2)
    expect(getCapturedRuntime().ws.get().seenDeliveryOperations.get(frame.operationId))
      .toEqual({ digest: frame.operationDigest, completed: false })
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch-1", serverId: "s1" }).liveIds).toContain("message-before-second-child-fault")
    expect(canonicalMessage("message-before-second-child-fault")?.content).toBe("hello")
    expect(vi.mocked(capturedQueryClient.invalidateQueries))
      .toHaveBeenCalledTimes(invalidationsAfterFailure)

    capturedOnMessage!(frame)
    expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(2)
    expect(getCapturedRuntime().ws.get().seenDeliveryOperations.get(frame.operationId))
      .toEqual({ digest: frame.operationDigest, completed: true })
    expect(getCapturedRuntime().ws.get().seenMessageIds.size).toBe(1)
    expect(getMessageStreamState(capturedQueryClient, { kind: "channel", id: "ch-1", serverId: "s1" }).liveIds.length)
      .toBe(1)

    const invalidationsAfterCompletion = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length
    capturedOnMessage!(frame)
    expect(vi.mocked(capturedQueryClient.invalidateQueries))
      .toHaveBeenCalledTimes(invalidationsAfterCompletion)
  })

  it("replays every legal committed-message child idempotently after a partial parent projection", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"))
    await mountHook({ viewerUserId: "viewer-1" })
    getCapturedRuntime().ui.actions.subscribe({ channelId: "other-channel" })
    capturedQueryClient.setQueryData(communityKeys.server("s1"), {
      id: "s1",
      categories: [{
        id: "category-1",
        channels: [{ id: "forum_1", type: "forum", unread: false }],
      }],
    })
    capturedQueryClient.setQueryData(
      communityKeys.forumSidebarThreads("s1"),
      forumSidebarFixture(["ch-1"]),
    )
    capturedQueryClient.setQueryData(communityKeys.servers(), {
      servers: [{ id: "s1", mentions: 5 }],
    })
    capturedQueryClient.setQueryData(communityKeys.channelMessages("forum_1"), {
      pages: [{
        messages: [{
          id: "opener-1",
          thread: { id: "ch-1", name: "thread", messageCount: 1 },
        }],
        hasMore: false,
      }],
      pageParams: [null],
    })
    seedCanonicalThread("s1", "forum_1", "forum", "ch-1")
    const parentScope = { kind: "channel" as const, id: "forum_1", serverId: "s1" }
    seedCanonicalStream(parentScope, {
      type: "wsMessage",
      message: {
        id: "opener-1",
        seq: 1,
        type: "chat",
        authorId: "author-1",
        authorName: "Alice",
        content: "opener",
        createdAt: "2026-08-20T00:00:00.000Z",
        thread: { id: "ch-1", name: "thread", messageCount: 1 },
      },
    })
    const { captureChannelMetadataToken } = await import("@/hooks/community/channel-metadata")
    const verification = captureChannelMetadataToken(capturedQueryClient, "ch-1")
    await act(async () => { await seedConversationEntry(capturedQueryClient, conversationEntryFromChannel({ id: "ch-1", serverId: "s1", type: "thread", name: "thread", parentChannelId: "forum_1", parentMessageId: "opener-1", creatorId: "viewer-1", archived: false, createdAt: "2026-08-20T00:00:00.000Z" }, verification.viewerId!)) })
    vi.spyOn(capturedQueryClient, "invalidateQueries")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const originalPublish = canonicalSync.projectCommunityWsEventToDb
    const publish = vi.spyOn(canonicalSync, "projectCommunityWsEventToDb").mockImplementation((client, event) => {
      const result = originalPublish(client, event)
      if (event.type === "community:channel.child_update") throw new Error("partial parent projection fault")
      return result
    })
    const frame = await batchFor("message-projection-fault", [
      {
        ...message,
        serverId: "s1",
        parentChannelId: "forum_1",
        message: { ...message.message, id: "message-before-fault" },
      },
      {
        type: "community:unread.bump",
        userId: "viewer-1",
        channelId: "ch-1",
        serverId: "s1",
        railChannelId: "forum_1",
        isMention: true,
      },
      {
        type: "community:mention.create",
        userId: "viewer-1",
        messageId: "message-before-fault",
        channelId: "ch-1",
        authorName: "Alice",
      },
      {
        type: "community:channel.member_add",
        userId: "viewer-1",
        serverId: "s1",
        channelId: "ch-1",
      },
      {
        type: "community:channel.child_update",
        parentChannelId: "forum_1",
        channelId: "ch-1",
        changes: { messageCount: 2, lastMessageAt: "2026-08-21T00:00:00.000Z" },
      },
    ])

    try {
      capturedOnMessage!(frame)
      expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(1)
      expect(getCapturedRuntime().ws.get().seenDeliveryOperations.get(frame.operationId))
        .toEqual({ digest: frame.operationDigest, completed: false })
      // All preceding children are legal committed-message projections. Their
      // writes remain visible when the final parent projection throws.
      expect(getCapturedRuntime().ws.get().seenMessageIds.has("message-before-fault")).toBe(true)
      expect(capturedQueryClient.getQueryData<{
        servers: Array<{ id: string; mentions: number }>
      }>(communityKeys.servers())?.servers[0]?.mentions).toBe(5)
      expect(capturedQueryClient.getQueryData<{
        pages: Array<{ messages: Array<{ thread: { messageCount: number } }> }>
      }>(communityKeys.channelMessages("forum_1"))?.pages[0]?.messages[0]?.thread.messageCount)
        .toBe(1)
      expect(canonicalMessage("opener-1")?.thread?.messageCount)
        .toBe(2)
    } finally {
      publish.mockRestore()
    }

    capturedOnMessage!(frame)
    expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(1)
    expect(getCapturedRuntime().ws.get().seenDeliveryOperations.get(frame.operationId))
      .toEqual({ digest: frame.operationDigest, completed: true })
    expect(getCapturedRuntime().ws.get().seenMessageIds.size).toBe(1)
    expect(capturedQueryClient.getQueryData<{
      servers: Array<{ id: string; mentions: number }>
    }>(communityKeys.servers())?.servers[0]?.mentions).toBe(5)
    expect(capturedQueryClient.getQueryData<{
      pages: Array<{ messages: Array<{ thread: { messageCount: number } }> }>
    }>(communityKeys.channelMessages("forum_1"))?.pages[0]?.messages[0]?.thread.messageCount)
      .toBe(1)
    expect(canonicalMessage("opener-1")?.thread?.messageCount)
      .toBe(2)

    const invalidationsAfterSuccess = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length
    capturedOnMessage!(frame)
    expect(vi.mocked(capturedQueryClient.invalidateQueries))
      .toHaveBeenCalledTimes(invalidationsAfterSuccess)
  })

  it("reports a rejected authoritative reconciliation after a digest conflict", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    reconcileCommunityWsReconnect.mockRejectedValueOnce(new Error("reconcile unavailable"))
    await mountHook({ viewerUserId: "viewer-1" })
    const first = await batchFor("message-reconcile-reject", mentionEvents)
    const conflicting = await batchFor("message-reconcile-reject", [
      { ...message, message: { ...message.message, content: "different" } },
    ])

    capturedOnMessage!(first)
    capturedOnMessage!(conflicting)

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "[ws] batch reconciliation failed",
        expect.objectContaining({ reason: "digest-conflict" }),
      )
    })
  })
})
