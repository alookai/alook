import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES,
  COMMUNITY_BROWSER_EVENT_BATCH_TYPE,
  deriveCommunityDeliveryOperationId,
  encodeCommunityBrowserEventBatch,
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
  cleanupCommunityWsHarness,
  forumSidebarFixture,
  getCommunityApiFetchMock,
  mountHook,
  resetCommunityWsHarness,
} from "./test-harness"
import { useCommunityStore } from "@/stores/community"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import {
  SEEN_DELIVERY_OPERATION_MAX,
  SEEN_DELIVERY_OPERATION_TRIM_TO,
} from "@/stores/community/ws"
import {
  registerReadSurface,
  releaseReadSurface,
  submitReadIntent,
} from "@/hooks/community/read-coordinator"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"

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

describe("useCommunityWs — operation bundles", () => {
  it("applies archive and null-tag sidebar semantics inside committed batches", async () => {
    await mountHook()
    const baseKey = communityKeys.forumSidebarThreads("s1")
    const metaKey = communityKeys.channelMeta("s1", "post_1")
    const hintKey = communityKeys.forumOpenerHint("s1", "opener-post_1")
    capturedQueryClient.setQueryData(communityKeys.server("s1"), {
      id: "s1",
      categories: [{ id: "cat_1", channels: [{ id: "forum_1", type: "forum" }] }],
    })
    capturedQueryClient.setQueryData(baseKey, forumSidebarFixture(["post_1", "post_2"]))
    capturedQueryClient.setQueryData(metaKey, {
      id: "post_1",
      parentChannelId: "forum_1",
      parentMessageId: "opener-post_1",
    })
    capturedQueryClient.setQueryData(hintKey, {
      id: "opener-post_1",
      content: "Post one",
    })

    capturedOnMessage!(await batchFor("forum-archive", [{
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "post_1",
      changes: { tags: ["archived"] },
    }]))

    expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(baseKey)
      ?.threads.map(({ id }) => id)).toEqual(["post_2"])
    expect(capturedQueryClient.getQueryData(metaKey)).toMatchObject({ id: "post_1" })
    expect(capturedQueryClient.getQueryData(hintKey)).toEqual({
      id: "opener-post_1",
      content: "Post one",
    })
    await vi.waitFor(() => {
      expect(capturedQueryClient.getQueryState(baseKey)?.isInvalidated).toBe(true)
    })

    capturedQueryClient.setQueryData(baseKey, forumSidebarFixture(["post_2"]))
    capturedOnMessage!(await batchFor("forum-unarchive", [{
      type: "community:channel.child_update",
      parentChannelId: "forum_1",
      channelId: "post_1",
      changes: { tags: null },
    }]))

    expect(capturedQueryClient.getQueryData<ReturnType<typeof forumSidebarFixture>>(baseKey)
      ?.threads.map(({ id }) => id)).toEqual(["post_2"])
    expect(capturedQueryClient.getQueryData(metaKey)).toMatchObject({ id: "post_1" })
    expect(capturedQueryClient.getQueryData(hintKey)).toEqual({
      id: "opener-post_1",
      content: "Post one",
    })
  })

  it("merges multiple requests into one queued successor generation", async () => {
    vi.useFakeTimers()
    try {
      useCommunityStore.getState().subscribe({ channelId: "ch-1" })
      await mountHook({ viewerUserId: "viewer-1" })
      let releaseRead!: () => void
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      getCommunityApiFetchMock().mockImplementation(async (url: unknown) => {
        if (typeof url === "string" && url.endsWith("/read")) {
          await readGate
          return { changed: true, revision: 1, targetSeq: 1 }
        }
        if (url === "/api/community/users/me/read-state") {
          return {
            revision: 1,
            readStates: [{
              channelId: "ch-1",
              lastReadMessageId: "message-1",
              lastReadAt: "2026-08-27T00:00:00.000Z",
              lastReadSeq: 1,
            }],
          }
        }
        throw new Error(`unexpected API fetch: ${String(url)}`)
      })
      vi.spyOn(capturedQueryClient, "invalidateQueries")
      const lease = registerReadSurface(
        capturedQueryClient,
        "viewer-1",
        { kind: "timeline", channelId: "ch-1" },
      )

      capturedOnMessage!({
        type: "community:mention.create",
        userId: "viewer-1",
        messageId: "mention-current",
        channelId: "ch-1",
        authorName: "Alice",
      })
      expect(submitReadIntent(lease, {
        kind: "timeline",
        channelId: "ch-1",
        messageId: "message-1",
        seq: 1,
      })).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(getCommunityApiFetchMock()).toHaveBeenCalledWith(
        "/api/community/channels/ch-1/read",
        expect.anything(),
      ))

      capturedOnMessage!({
        type: "community:mention.create",
        userId: "viewer-1",
        messageId: "mention-next",
        channelId: "ch-1",
        authorName: "Alice",
      })
      capturedOnMessage!({
        ...message,
        message: { ...message.message, id: "message-next", seq: 2 },
      })
      releaseRead()
      await vi.advanceTimersByTimeAsync(500)

      expect(invalidationCount(communityKeys.inbox())).toBe(1)
      expect(invalidationCount(communityKeys.dms())).toBe(1)
      releaseReadSurface(lease)
    } finally {
      vi.useRealTimers()
    }
  })

  it("carries a deferred wide generation into its narrower successor", async () => {
    vi.useFakeTimers()
    try {
      useCommunityStore.getState().subscribe({ channelId: "ch-1" })
      await mountHook({ viewerUserId: "viewer-1" })
      let releaseRead!: () => void
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      getCommunityApiFetchMock().mockImplementation(async (url: unknown) => {
        if (typeof url === "string" && url.endsWith("/read")) {
          await readGate
          return { changed: true, revision: 1, targetSeq: 1 }
        }
        if (url === "/api/community/users/me/read-state") {
          return {
            revision: 1,
            readStates: [{
              channelId: "ch-1",
              lastReadMessageId: "message-1",
              lastReadAt: "2026-08-27T00:00:00.000Z",
              lastReadSeq: 1,
            }],
          }
        }
        throw new Error(`unexpected API fetch: ${String(url)}`)
      })
      vi.spyOn(capturedQueryClient, "invalidateQueries")
      const lease = registerReadSurface(
        capturedQueryClient,
        "viewer-1",
        { kind: "timeline", channelId: "ch-1" },
      )

      capturedOnMessage!(message)
      expect(submitReadIntent(lease, {
        kind: "timeline",
        channelId: "ch-1",
        messageId: "message-1",
        seq: 1,
      })).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(getCommunityApiFetchMock()).toHaveBeenCalledWith(
        "/api/community/channels/ch-1/read",
        expect.anything(),
      ))

      capturedOnMessage!({
        type: "community:mention.create",
        userId: "viewer-1",
        messageId: "mention-2",
        channelId: "ch-1",
        authorName: "Alice",
      })
      releaseRead()
      await vi.advanceTimersByTimeAsync(500)

      expect(invalidationCount(communityKeys.inbox())).toBe(1)
      expect(invalidationCount(communityKeys.dms())).toBe(1)
      releaseReadSurface(lease)
    } finally {
      vi.useRealTimers()
    }
  })

  it("skips current raw refresh when a deferred later intent has no owner successor", async () => {
    vi.useFakeTimers()
    try {
      useCommunityStore.getState().subscribe({ channelId: "ch-1" })
      await mountHook({ viewerUserId: "viewer-1" })
      let releaseFirstRead!: () => void
      const firstReadGate = new Promise<void>((resolve) => {
        releaseFirstRead = resolve
      })
      let readCalls = 0
      getCommunityApiFetchMock().mockImplementation(async (url: unknown) => {
        if (typeof url === "string" && url.endsWith("/read")) {
          readCalls += 1
          if (readCalls === 1) await firstReadGate
          return { changed: true, revision: readCalls, targetSeq: readCalls }
        }
        if (url === "/api/community/users/me/read-state") {
          return {
            revision: readCalls,
            readStates: [{
              channelId: "ch-1",
              lastReadMessageId: `message-${readCalls}`,
              lastReadAt: "2026-08-27T00:00:00.000Z",
              lastReadSeq: readCalls,
            }],
          }
        }
        throw new Error(`unexpected API fetch: ${String(url)}`)
      })
      vi.spyOn(capturedQueryClient, "invalidateQueries")
      const lease = registerReadSurface(
        capturedQueryClient,
        "viewer-1",
        { kind: "timeline", channelId: "ch-1" },
      )

      capturedOnMessage!(message)
      expect(submitReadIntent(lease, {
        kind: "timeline",
        channelId: "ch-1",
        messageId: "message-1",
        seq: 1,
      })).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(readCalls).toBe(1))

      expect(submitReadIntent(lease, {
        kind: "timeline",
        channelId: "ch-1",
        messageId: "message-2",
        seq: 2,
      })).toBe(true)
      releaseFirstRead()
      await vi.advanceTimersByTimeAsync(499)
      expect(readCalls).toBe(1)
      expect(invalidationCount(communityKeys.inbox())).toBe(0)
      expect(invalidationCount(communityKeys.dms())).toBe(0)

      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(readCalls).toBe(2))
      await vi.waitFor(() => {
        expect(invalidationCount(communityKeys.inbox())).toBe(1)
        expect(invalidationCount(communityKeys.dms())).toBe(1)
      })
      releaseReadSurface(lease)
    } finally {
      vi.useRealTimers()
    }
  })

  it("decodes all children before one dispatch, deduplicates invalidations, and suppresses same-digest replay", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "viewer-1" })
      capturedQueryClient.setQueryData(communityKeys.servers(), {
        servers: [{ id: "server-1", mentions: 5 }],
      })
      vi.spyOn(capturedQueryClient, "invalidateQueries")
      const frame = await batchFor("message-1", mentionEvents)

      capturedOnMessage!(frame)
      expect(capturedQueryClient.getQueryData<{ servers: Array<{ id: string; mentions: number }> }>(
        communityKeys.servers(),
      )?.servers[0]?.mentions).toBe(5)
      const unreadProjection = getActiveAccountUnreadProjection(capturedQueryClient)
      expect(unreadProjection.projectUnread("servers", "ch-1", false)).toBe(true)
      // A correlated bundle carries seq=1 dispatch-locally, so a real visible
      // read can cover it. An orphan/sticky bump would deliberately survive.
      unreadProjection.recordRead("ch-1", 1)
      expect(unreadProjection.projectUnread("servers", "ch-1", false)).toBe(false)
      expect(invalidationCount(communityKeys.inbox())).toBe(0)
      expect(invalidationCount(communityKeys.dms())).toBe(0)
      expect(invalidationCount(communityKeys.servers())).toBe(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(invalidationCount(communityKeys.inbox())).toBe(1)
      expect(invalidationCount(communityKeys.dms())).toBe(1)

      const callsAfterFirst = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length
      capturedOnMessage!(frame)
      await vi.advanceTimersByTimeAsync(500)
      expect(vi.mocked(capturedQueryClient.invalidateQueries)).toHaveBeenCalledTimes(callsAfterFirst)
      const { useCommunityWsStore } = await import("@/stores/community/ws")
      expect(useCommunityWsStore.getState().seenDeliveryOperations.get(frame.operationId))
        .toEqual({ digest: frame.operationDigest, completed: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it("treats an ambiguous same-channel bundle as sticky instead of temporally pairing", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    const frame = await batchFor("ambiguous-bump", [
      { ...message, message: { ...message.message, id: "ambiguous-1", seq: 1 } },
      { ...message, message: { ...message.message, id: "ambiguous-2", seq: 2 } },
      mentionEvents[1]!,
    ])
    capturedOnMessage!(frame)
    const projection = getActiveAccountUnreadProjection(capturedQueryClient)
    projection.recordRead("ch-1", 999)
    expect(projection.projectUnread("servers", "ch-1", false)).toBe(true)
  })

  it("correlates a unique same-channel bump regardless of child order", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    const frame = await batchFor("reordered-bump", [
      mentionEvents[1]!,
      mentionEvents[2]!,
      mentionEvents[0]!,
    ])
    capturedOnMessage!(frame)
    const projection = getActiveAccountUnreadProjection(capturedQueryClient)
    expect(projection.projectUnread("servers", "ch-1", false)).toBe(true)
    projection.recordRead("ch-1", 1)
    expect(projection.projectUnread("servers", "ch-1", false)).toBe(false)
  })

  it("does not borrow seq evidence for a different mention message id", async () => {
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
    const projection = getActiveAccountUnreadProjection(capturedQueryClient)
    projection.recordRead("ch-1", 999)
    expect(projection.projectUnread("inbox-mentions", "ch-1", false)).toBe(true)
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
    const first = capturedQueryClient.fetchQuery({ queryKey: key, queryFn, staleTime: 0 })
      .catch(() => undefined)
    await vi.waitFor(() => expect(queryCalls).toBe(1))
    const cancel = vi.spyOn(capturedQueryClient, "cancelQueries")

    capturedOnMessage!(await batchFor("message-fenced-mention", mentionEvents))

    expect(queryCalls).toBe(1)
    expect(cancel).not.toHaveBeenCalled()
    expect(getActiveAccountUnreadProjection(capturedQueryClient)
      .projectServerUnread("server-1", [])).toBe(true)
    await capturedQueryClient.cancelQueries({ queryKey: key, exact: true })
    await first
  })

  it("treats repair-then-late-bundle mention state as authoritative invalidation, never arithmetic", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "viewer-1" })
      const { useCommunityWsStore } = await import("@/stores/community/ws")
      useCommunityWsStore.getState().markSeenMessage(message.message.id)
      capturedQueryClient.setQueryData(communityKeys.servers(), {
        servers: [{ id: "server-1", mentions: 9 }],
      })
      vi.spyOn(capturedQueryClient, "invalidateQueries")

      capturedOnMessage!(await batchFor("message-late", mentionEvents))
      expect(capturedQueryClient.getQueryData<{ servers: Array<{ mentions: number }> }>(
        communityKeys.servers(),
      )?.servers[0]?.mentions).toBe(9)
      expect(invalidationCount(communityKeys.inbox())).toBe(0)
      expect(invalidationCount(communityKeys.dms())).toBe(0)
      expect(invalidationCount(communityKeys.servers())).toBe(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(invalidationCount(communityKeys.inbox())).toBe(1)
      expect(invalidationCount(communityKeys.dms())).toBe(1)
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
    expect(useCommunityWsStore.getState().seenDeliveryOperations.size).toBe(0)
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
    useCommunityStore.getState().subscribe({ channelId: "ch-1" })
    vi.spyOn(capturedQueryClient, "invalidateQueries")
    const first = await batchFor("message-conflict", mentionEvents)
    const conflicting = await batchFor("message-conflict", [
      { ...message, message: { ...message.message, content: "different" } },
    ])
    capturedOnMessage!(first)
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const seenMessages = useCommunityWsStore.getState().seenMessageIds.size
    const overlayBeforeConflict = getMessageOverlay({
      kind: "channel",
      id: "ch-1",
      serverId: "s1",
    })
    const invalidationsBeforeConflict = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length

    capturedOnMessage!(conflicting)
    expect(useCommunityWsStore.getState().seenMessageIds.size).toBe(seenMessages)
    expect(getMessageOverlay({ kind: "channel", id: "ch-1", serverId: "s1" }))
      .toBe(overlayBeforeConflict)
    expect(vi.mocked(capturedQueryClient.invalidateQueries))
      .toHaveBeenCalledTimes(invalidationsBeforeConflict)
    expect(useCommunityWsStore.getState().seenDeliveryOperations.get(first.operationId))
      .toEqual({ digest: first.operationDigest, completed: true })
    expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(1)
  })

  it("locks the digest across a second-child fault, rejects conflict, then completes replay", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    useCommunityStore.getState().subscribe({ channelId: "ch-1" })
    capturedQueryClient.setQueryData(communityKeys.server("s1"), {
      id: "s1",
      categories: [{
        id: "category-1",
        channels: [{ id: "text-parent", type: "text", unread: false }],
      }],
    })
    const unreadProjection = getActiveAccountUnreadProjection(capturedQueryClient)
    const recordArrival = vi.spyOn(unreadProjection, "recordArrival")
      .mockImplementationOnce(() => { throw new Error("second-child fault") })
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
    expect(useCommunityWsStore.getState().seenDeliveryOperations.get(frame.operationId))
      .toEqual({ digest: frame.operationDigest, completed: false })
    expect(getMessageOverlay({ kind: "channel", id: "ch-1", serverId: "s1" })
      .liveById.has("message-before-second-child-fault")).toBe(true)

    recordArrival.mockRestore()
    const invalidationsAfterFailure = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length
    capturedOnMessage!(conflicting)
    expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(2)
    expect(useCommunityWsStore.getState().seenDeliveryOperations.get(frame.operationId))
      .toEqual({ digest: frame.operationDigest, completed: false })
    expect(getMessageOverlay({ kind: "channel", id: "ch-1", serverId: "s1" })
      .liveById.get("message-before-second-child-fault")?.content).toBe("hello")
    expect(vi.mocked(capturedQueryClient.invalidateQueries))
      .toHaveBeenCalledTimes(invalidationsAfterFailure)

    capturedOnMessage!(frame)
    expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(2)
    expect(useCommunityWsStore.getState().seenDeliveryOperations.get(frame.operationId))
      .toEqual({ digest: frame.operationDigest, completed: true })
    expect(useCommunityWsStore.getState().seenMessageIds.size).toBe(1)
    expect(getMessageOverlay({ kind: "channel", id: "ch-1", serverId: "s1" }).liveById.size)
      .toBe(1)
    expect(unreadProjection.projectServerChannelUnread(
      "s1",
      "text-parent",
      [],
    )).toBe(true)

    const invalidationsAfterCompletion = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length
    capturedOnMessage!(frame)
    expect(vi.mocked(capturedQueryClient.invalidateQueries))
      .toHaveBeenCalledTimes(invalidationsAfterCompletion)
  })

  it("replays every legal committed-message child idempotently after a partial parent projection", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"))
    await mountHook({ viewerUserId: "viewer-1" })
    useCommunityStore.getState().subscribe({ channelId: "other-channel" })
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
    const parentScope = { kind: "channel" as const, id: "forum_1", serverId: "s1" }
    useMessageStreamStore.getState().dispatch(parentScope, {
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
    vi.spyOn(capturedQueryClient, "invalidateQueries")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const originalDispatch = useMessageStreamStore.getState().dispatch
    useMessageStreamStore.setState({
      dispatch: (scope, event) => {
        originalDispatch(scope, event)
        throw new Error("partial parent projection fault")
      },
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
      expect(useCommunityWsStore.getState().seenDeliveryOperations.get(frame.operationId))
        .toEqual({ digest: frame.operationDigest, completed: false })
      // All preceding children are legal committed-message projections. Their
      // writes remain visible when the final parent projection throws.
      expect(useCommunityWsStore.getState().seenMessageIds.has("message-before-fault")).toBe(true)
      expect(getActiveAccountUnreadProjection(capturedQueryClient).projectUnread(
        "server-detail:s1",
        "ch-1",
        false,
      )).toBe(true)
      expect(capturedQueryClient.getQueryData<{
        servers: Array<{ id: string; mentions: number }>
      }>(communityKeys.servers())?.servers[0]?.mentions).toBe(5)
      expect(capturedQueryClient.getQueryData<{
        pages: Array<{ messages: Array<{ thread: { messageCount: number } }> }>
      }>(communityKeys.channelMessages("forum_1"))?.pages[0]?.messages[0]?.thread.messageCount)
        .toBe(2)
      expect(getMessageOverlay(parentScope).liveById.get("opener-1")?.thread?.messageCount)
        .toBe(2)
    } finally {
      useMessageStreamStore.setState({ dispatch: originalDispatch })
    }

    capturedOnMessage!(frame)
    expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(1)
    expect(useCommunityWsStore.getState().seenDeliveryOperations.get(frame.operationId))
      .toEqual({ digest: frame.operationDigest, completed: true })
    expect(useCommunityWsStore.getState().seenMessageIds.size).toBe(1)
    expect(capturedQueryClient.getQueryData<{
      servers: Array<{ id: string; mentions: number }>
    }>(communityKeys.servers())?.servers[0]?.mentions).toBe(5)
    expect(getActiveAccountUnreadProjection(capturedQueryClient).projectUnread(
      "server-detail:s1",
      "ch-1",
      false,
    )).toBe(true)
    expect(capturedQueryClient.getQueryData<{
      pages: Array<{ messages: Array<{ thread: { messageCount: number } }> }>
    }>(communityKeys.channelMessages("forum_1"))?.pages[0]?.messages[0]?.thread.messageCount)
      .toBe(2)
    expect(getMessageOverlay(parentScope).liveById.get("opener-1")?.thread?.messageCount)
      .toBe(2)

    const invalidationsAfterSuccess = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length
    capturedOnMessage!(frame)
    expect(vi.mocked(capturedQueryClient.invalidateQueries))
      .toHaveBeenCalledTimes(invalidationsAfterSuccess)
  })

  it.each(["before", "after"] as const)(
    "keeps one barrier-owned refresh when an identical retry lands %s the first deadline",
    async (retryTiming) => {
      vi.useFakeTimers()
      try {
        useCommunityStore.getState().subscribe({ channelId: "ch-1" })
        await mountHook({ viewerUserId: "viewer-1" })
        capturedQueryClient.setQueryData(communityKeys.server("s1"), {
          id: "s1",
          categories: [{
            id: "category-1",
            channels: [{ id: "parent-1", type: "text", unread: false }],
          }],
        })
        getCommunityApiFetchMock().mockImplementation(async (url: unknown) => {
          if (typeof url === "string" && url.endsWith("/read")) {
            return { changed: true, revision: 1, targetSeq: 1 }
          }
          if (url === "/api/community/users/me/read-state") {
            return {
              revision: 1,
              readStates: [{
                channelId: "ch-1",
                lastReadMessageId: `retry-${retryTiming}`,
                lastReadAt: "2026-08-27T00:00:00.000Z",
                lastReadSeq: 1,
              }],
            }
          }
          throw new Error(`unexpected API fetch: ${String(url)}`)
        })
        const unreadProjection = getActiveAccountUnreadProjection(capturedQueryClient)
        const recordArrival = vi.spyOn(unreadProjection, "recordArrival")
          .mockImplementationOnce(() => { throw new Error("later child fault") })
        vi.spyOn(capturedQueryClient, "invalidateQueries")
        const messageId = `retry-${retryTiming}`
        const frame = await batchFor(messageId, [
          {
            ...message,
            serverId: "s1",
            parentChannelId: "parent-1",
            message: { ...message.message, id: messageId },
          },
          {
            type: "community:unread.bump",
            userId: "viewer-1",
            channelId: "ch-1",
            serverId: "s1",
            railChannelId: "parent-1",
            isMention: false,
          },
        ])
        const lease = registerReadSurface(
          capturedQueryClient,
          "viewer-1",
          { kind: "timeline", channelId: "ch-1" },
        )

        capturedOnMessage!(frame)
        expect(reconcileCommunityWsReconnect).toHaveBeenCalledWith(
          capturedQueryClient,
          0,
          { excludePolicies: ["inbox-dms"] },
        )
        expect(invalidationCount(communityKeys.inbox())).toBe(0)
        expect(invalidationCount(communityKeys.dms())).toBe(0)
        expect(submitReadIntent(lease, {
          kind: "timeline",
          channelId: "ch-1",
          messageId,
          seq: 1,
        })).toBe(true)

        recordArrival.mockRestore()
        if (retryTiming === "before") capturedOnMessage!(frame)
        await vi.advanceTimersByTimeAsync(500)
        expect(invalidationCount(communityKeys.inbox())).toBe(1)
        expect(invalidationCount(communityKeys.dms())).toBe(1)
        if (retryTiming === "after") capturedOnMessage!(frame)
        await vi.advanceTimersByTimeAsync(500)

        expect(invalidationCount(communityKeys.inbox())).toBe(1)
        expect(invalidationCount(communityKeys.dms())).toBe(1)
        const { useCommunityWsStore } = await import("@/stores/community/ws")
        expect(useCommunityWsStore.getState().seenDeliveryOperations.get(frame.operationId))
          .toEqual({ digest: frame.operationDigest, completed: true })
        releaseReadSurface(lease)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it("bounds normal and conflict refresh keys with the delivery-operation limits", async () => {
    vi.useFakeTimers()
    try {
      await mountHook({ viewerUserId: "viewer-1" })
      vi.spyOn(capturedQueryClient, "invalidateQueries")
      const original = await batchFor("bounded-operation", [{
        ...message,
        message: { ...message.message, id: "bounded-operation" },
      }])
      capturedOnMessage!(original)
      const conflicts: Awaited<ReturnType<typeof batchFor>>[] = []
      for (let index = 0; index < SEEN_DELIVERY_OPERATION_MAX; index += 1) {
        const conflict = await batchFor("bounded-operation", [{
          ...message,
          message: {
            ...message.message,
            id: "bounded-operation",
            content: `conflict-${index}`,
          },
        }])
        conflicts.push(conflict)
        capturedOnMessage!(conflict)
      }

      await vi.advanceTimersByTimeAsync(500)
      expect(invalidationCount(communityKeys.inbox())).toBe(1)
      capturedOnMessage!(conflicts[0]!)
      await vi.advanceTimersByTimeAsync(500)
      expect(invalidationCount(communityKeys.inbox())).toBe(2)
      capturedOnMessage!(conflicts.at(-1)!)
      await vi.advanceTimersByTimeAsync(500)
      expect(invalidationCount(communityKeys.inbox())).toBe(2)
      expect(SEEN_DELIVERY_OPERATION_TRIM_TO).toBeLessThan(SEEN_DELIVERY_OPERATION_MAX)
    } finally {
      vi.useRealTimers()
    }
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
