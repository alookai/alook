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
  mountHook,
  resetCommunityWsHarness,
} from "./test-harness"
import { useCommunityStore } from "@/stores/community"
import { getMessageOverlay } from "@/stores/community/message-stream"

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
  it("decodes all children before one dispatch, deduplicates invalidations, and suppresses same-digest replay", async () => {
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
    expect(invalidationCount(communityKeys.inbox())).toBe(1)
    expect(invalidationCount(communityKeys.dms())).toBe(1)
    expect(invalidationCount(communityKeys.servers())).toBe(1)

    const callsAfterFirst = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length
    capturedOnMessage!(frame)
    expect(vi.mocked(capturedQueryClient.invalidateQueries)).toHaveBeenCalledTimes(callsAfterFirst)
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    expect(useCommunityWsStore.getState().seenDeliveryOperations.get(frame.operationId))
      .toBe(frame.operationDigest)
  })

  it("treats repair-then-late-bundle mention state as authoritative invalidation, never arithmetic", async () => {
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
    expect(invalidationCount(communityKeys.inbox())).toBe(1)
    expect(invalidationCount(communityKeys.dms())).toBe(1)
    expect(invalidationCount(communityKeys.servers())).toBe(1)
  })

  it("rejects malformed children without poisoning the operation map", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    const frame = await batchFor("message-malformed", mentionEvents)
    capturedOnMessage!({
      ...frame,
      events: [...frame.events, { type: "community:future", contractVersion: 1 }],
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
    capturedOnMessage!({
      type: "community:message.create",
      contractVersion: 2,
    })

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
      expect.objectContaining({ type: "community:message.create", contractVersion: 2 }),
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
      .toBe(first.operationDigest)
    expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(1)
  })

  it("leaves a partially projected operation retryable and commits dedup only after replay converges", async () => {
    await mountHook({ viewerUserId: "viewer-1" })
    useCommunityStore.getState().subscribe({ channelId: "ch-1" })
    vi.spyOn(capturedQueryClient, "invalidateQueries")
    const { useCommunityWsStore } = await import("@/stores/community/ws")
    const original = useCommunityWsStore.getState().setPresence
    useCommunityWsStore.setState({ setPresence: () => { throw new Error("projection fault") } })
    const frame = await batchFor("message-projection-fault", [
      { ...message, message: { ...message.message, id: "message-before-fault" } },
      {
        type: "community:presence.update",
        userId: "user-2",
        online: true,
      },
    ])
    try {
      capturedOnMessage!(frame)
      expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(1)
      expect(useCommunityWsStore.getState().seenDeliveryOperations.has(frame.operationId))
        .toBe(false)
      // The first child proves notifyManager.batch is not a rollback boundary:
      // its state is already visible when the later presence child throws.
      expect(useCommunityWsStore.getState().seenMessageIds.has("message-before-fault")).toBe(true)
      expect(getMessageOverlay({
        kind: "channel",
        id: "ch-1",
        serverId: "s1",
      }).liveById.has("message-before-fault")).toBe(true)

      useCommunityWsStore.setState({ setPresence: original })
      capturedOnMessage!(frame)
      expect(reconcileCommunityWsReconnect).toHaveBeenCalledTimes(1)
      expect(useCommunityWsStore.getState().onlineUserIds.has("user-2")).toBe(true)
      expect(useCommunityWsStore.getState().seenDeliveryOperations.get(frame.operationId))
        .toBe(frame.operationDigest)

      const invalidationsAfterSuccess = vi.mocked(capturedQueryClient.invalidateQueries).mock.calls.length
      capturedOnMessage!(frame)
      expect(vi.mocked(capturedQueryClient.invalidateQueries))
        .toHaveBeenCalledTimes(invalidationsAfterSuccess)
    } finally {
      useCommunityWsStore.setState({ setPresence: original })
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
