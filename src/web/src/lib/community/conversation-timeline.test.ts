import { describe, expect, it, vi } from "vitest"
import type { CommunityReadStateResource } from "@alook/shared"
import type { CanonicalMessage } from "./message-stream"
import {
  createConversationTimelineStore,
  mergeTimelinePages,
  selectTimelineNewDivider,
  type TimelineCanonicalPage,
} from "./conversation-timeline"

function canonical(overrides: Partial<CanonicalMessage> & { id: string; seq: number }): CanonicalMessage {
  return {
    channelId: "ch_alpha",
    type: "chat",
    authorId: "u_alice",
    authorName: "Alice",
    authorAvatar: null,
    authorAvatarVersion: null,
    content: `message ${overrides.seq}`,
    createdAt: `2026-01-01T10:${String(overrides.seq).padStart(2, "0")}:00.000Z`,
    updatedAt: null,
    deletedAt: null,
    editedAt: null,
    pinned: false,
    replyToId: null,
    clientNonce: null,
    reactions: [],
    attachments: [],
    embeds: [],
    mentions: [],
    ...overrides,
  } as CanonicalMessage
}

function readState(overrides: Partial<CommunityReadStateResource> = {}): CommunityReadStateResource {
  return {
    channelId: "ch_alpha",
    lastReadMessageId: "m2",
    lastReadAt: "2026-01-01T10:02:00.000Z",
    lastReadSeq: 2,
    ...overrides,
  }
}

describe("ConversationTimeline", () => {
  it("renders skeleton only before qualified cache exists, then reveals cached rows immediately with decoupled readPositionReady", () => {
    const timeline = createConversationTimelineStore({ channelId: "ch_alpha", viewerUserId: "u_me" })

    const initial = timeline.getSnapshot()
    expect(initial.displayPhase).toBe("skeleton")
    expect(initial.showSkeleton).toBe(true)
    expect(initial.contentVisible).toBe(false)
    expect(initial.readQualification.readPositionReady).toBe(false)
    expect(initial.readQualification.paginationEligible).toBe(false)

    const cachedPage: TimelineCanonicalPage = {
      messages: [canonical({ id: "m1", seq: 1 }), canonical({ id: "m2", seq: 2 })],
      hasMoreOlder: true,
      hasMoreNewer: false,
      latestSeq: 2,
    }
    timeline.dispatch({
      type: "hydrateCache",
      payload: {
        pages: [cachedPage],
        accessQualified: true,
        targetCovered: false,
        reconcilingTarget: true,
      },
    })

    const cached = timeline.getSnapshot()
    expect(cached.displayPhase).toBe("revealed")
    expect(cached.showSkeleton).toBe(false)
    expect(cached.contentVisible).toBe(true)
    expect(cached.contentInteractive).toBe(true)
    expect(cached.messages.map((m) => m.id)).toEqual(["m1", "m2"])
    expect(cached.readQualification.readPositionReady).toBe(false)
    expect(cached.readQualification.paginationEligible).toBe(false)
    expect(cached.boundaries.reconciling).toBe(true)

    timeline.dispatch({
      type: "reconcileNetwork",
      payload: {
        pages: [
          {
            messages: [
              canonical({ id: "m1", seq: 1 }),
              canonical({ id: "m2", seq: 2 }),
              canonical({ id: "m3", seq: 3 }),
            ],
            hasMoreOlder: false,
            hasMoreNewer: false,
            latestSeq: 3,
          },
        ],
        readSnapshot: readState({ lastReadMessageId: "m2", lastReadSeq: 2 }),
        newBoundary: { afterSeq: 2, target: { id: "m3", channelId: "ch_alpha", seq: 3, authorId: "u_alice" } },
        accessQualified: true,
        targetCovered: true,
        reconcilingTarget: false,
      },
    })

    const reconciled = timeline.getSnapshot()
    expect(reconciled.displayPhase).toBe("revealed")
    expect(reconciled.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"])
    expect(reconciled.readQualification.readPositionReady).toBe(true)
    expect(reconciled.readQualification.paginationEligible).toBe(true)
    expect(reconciled.boundaries.reconciling).toBe(false)
    expect(reconciled.items.some((item) => item.kind === "divider" && item.newDivider && item.messageId === "m3")).toBe(true)
  })

  it("keeps first-row grouping stable across hasMoreOlder settlement during reconcile, while recomputing on genuine prepend", () => {
    const timeline = createConversationTimelineStore({ channelId: "ch_alpha", viewerUserId: "u_me" })

    timeline.dispatch({
      type: "hydrateCache",
      payload: {
        pages: [
          {
            messages: [
              canonical({ id: "m10", seq: 10, authorId: "u_alice" }),
              canonical({ id: "m11", seq: 11, authorId: "u_bob" }),
            ],
            hasMoreOlder: false,
            latestSeq: 11,
          },
        ],
      },
    })
    const firstBefore = timeline.getSnapshot().items.find((item) => item.kind === "message")!
    expect(firstBefore.kind === "message" && firstBefore.m.grouped).toBe(false)

    timeline.dispatch({
      type: "reconcileNetwork",
      payload: {
        pages: [
          {
            messages: [
              canonical({ id: "m10", seq: 10, authorId: "u_alice" }),
              canonical({ id: "m11", seq: 11, authorId: "u_bob" }),
            ],
            hasMoreOlder: true,
            latestSeq: 11,
          },
        ],
        readSnapshot: readState({ lastReadMessageId: "m11", lastReadSeq: 11 }),
      },
    })
    const firstAfterReconcile = timeline.getSnapshot().items.find((item) => item.kind === "message")!
    expect(firstAfterReconcile.kind === "message" && firstAfterReconcile.m.grouped).toBe(false)

    timeline.dispatch({
      type: "reconcileNetwork",
      payload: {
        pages: [
          {
            messages: [
              canonical({ id: "m9", seq: 9, authorId: "u_alice" }),
              canonical({ id: "m10", seq: 10, authorId: "u_alice" }),
              canonical({ id: "m11", seq: 11, authorId: "u_bob" }),
            ],
            hasMoreOlder: true,
            latestSeq: 11,
          },
        ],
        readSnapshot: readState({ lastReadMessageId: "m11", lastReadSeq: 11 }),
      },
    })
    const messageItems = timeline.getSnapshot().items.filter((item) => item.kind === "message")
    expect(messageItems[0]?.m.id).toBe("m9")
    expect(messageItems[0]?.m.grouped).toBe(true)
    expect(messageItems[1]?.m.id).toBe("m10")
    expect(messageItems[1]?.m.grouped).toBe(true)
  })

  it("reconciles optimistic send atomically into server canonical message with stable viewer-qualified key and object-URL revocation", () => {
    const onEffects = vi.fn()
    const timeline = createConversationTimelineStore(
      { channelId: "ch_alpha", viewerUserId: "u_me" },
      onEffects,
    )

    timeline.dispatch({
      type: "submitOptimistic",
      intent: {
        nonce: "nonce-1",
        tempId: "temp-1",
        localOrdinal: 1,
        message: {
          type: "chat",
          authorId: "u_me",
          authorName: "Me",
          content: "hello world",
          createdAt: "2026-01-01T10:05:00.000Z",
        },
        localUploads: [
          {
            file: new File(["x"], "photo.png", { type: "image/png" }),
            previewObjectUrl: "blob:preview-1",
            width: 320,
            height: 240,
          },
        ],
      },
    })

    const optimisticItem = timeline.getSnapshot().items.find((item) => item.kind === "message")!
    expect(optimisticItem.kind).toBe("message")
    expect(optimisticItem.kind === "message" && optimisticItem.m.id).toBe("temp-1")
    const optimisticKey = optimisticItem.key

    const confirmed = canonical({
      id: "msg_srv_1",
      seq: 5,
      authorId: "u_me",
      authorName: "Me",
      content: "hello world",
      clientNonce: "nonce-1",
    })
    const effects = timeline.dispatch({
      type: "confirmSendAck",
      nonce: "nonce-1",
      message: confirmed,
    })

    expect(effects).toEqual([{ type: "revokeObjectUrl", url: "blob:preview-1" }])
    expect(onEffects).toHaveBeenCalledWith([{ type: "revokeObjectUrl", url: "blob:preview-1" }])

    const confirmedItem = timeline.getSnapshot().items.find((item) => item.kind === "message")!
    expect(confirmedItem.key).toBe(optimisticKey)
    expect(confirmedItem.kind === "message" && confirmedItem.m.id).toBe("msg_srv_1")
    expect(timeline.getSnapshot().messages).toHaveLength(1)

    timeline.dispatch({
      type: "reconcileNetwork",
      payload: {
        pages: [{ messages: [confirmed], latestSeq: 5 }],
        readSnapshot: readState({ lastReadMessageId: "msg_srv_1", lastReadSeq: 5 }),
      },
    })
    const refetchedItem = timeline.getSnapshot().items.find((item) => item.kind === "message")!
    expect(refetchedItem.key).toBe(optimisticKey)
    expect(timeline.getSnapshot().messages).toHaveLength(1)
  })

  it("downgrades background refresh errors to silentRefreshError when cached rows remain readable (#361), while surfacing cold-entry errors", () => {
    const coldTimeline = createConversationTimelineStore({ channelId: "ch_cold", viewerUserId: "u_me" })
    const coldError = new Error("network offline")
    coldTimeline.dispatch({ type: "recordNetworkError", error: coldError })
    expect(coldTimeline.getSnapshot().readQualification.initialLoadError).toBe(coldError)
    expect(coldTimeline.getSnapshot().readQualification.silentRefreshError).toBeNull()
    expect(coldTimeline.getSnapshot().displayPhase).toBe("revealed")

    const warmTimeline = createConversationTimelineStore({ channelId: "ch_warm", viewerUserId: "u_me" })
    warmTimeline.dispatch({
      type: "hydrateCache",
      payload: { pages: [{ messages: [canonical({ id: "m1", seq: 1 })], latestSeq: 1 }] },
    })
    const refreshError = new Error("transient 503")
    warmTimeline.dispatch({ type: "recordNetworkError", error: refreshError })

    const warm = warmTimeline.getSnapshot()
    expect(warm.displayPhase).toBe("revealed")
    expect(warm.messages.map((m) => m.id)).toEqual(["m1"])
    expect(warm.readQualification.initialLoadError).toBeNull()
    expect(warm.readQualification.silentRefreshError).toBe(refreshError)
  })

  it("clears visible rows and disables read/pagination immediately on access revocation", () => {
    const timeline = createConversationTimelineStore({ channelId: "ch_alpha", viewerUserId: "u_me" })
    timeline.dispatch({
      type: "reconcileNetwork",
      payload: {
        pages: [{ messages: [canonical({ id: "m1", seq: 1 })], latestSeq: 1 }],
        readSnapshot: readState({ lastReadMessageId: "m1", lastReadSeq: 1 }),
      },
    })
    expect(timeline.getSnapshot().readQualification.readPositionReady).toBe(true)

    timeline.dispatch({ type: "revokeAccess" })
    const revoked = timeline.getSnapshot()
    expect(revoked.messages).toEqual([])
    expect(revoked.items).toEqual([])
    expect(revoked.readQualification.revoked).toBe(true)
    expect(revoked.readQualification.accessDenied).toBe(true)
    expect(revoked.readQualification.readPositionReady).toBe(false)
    expect(revoked.readQualification.paginationEligible).toBe(false)
  })

  it("retires New boundary cleanly without re-introducing retired target on subsequent reconcile", () => {
    const timeline = createConversationTimelineStore({ channelId: "ch_alpha", viewerUserId: "u_me" })
    timeline.dispatch({
      type: "reconcileNetwork",
      payload: {
        pages: [{ messages: [canonical({ id: "m1", seq: 1 }), canonical({ id: "m2", seq: 2 })], latestSeq: 2 }],
        readSnapshot: readState({ lastReadMessageId: "m1", lastReadSeq: 1 }),
        newBoundary: { afterSeq: 1, target: { id: "m2", channelId: "ch_alpha", seq: 2, authorId: "u_alice" } },
      },
    })
    expect(selectTimelineNewDivider(timeline.getSnapshot().messages, timeline.getSnapshot().newBoundary)).toBe("m2")

    timeline.dispatch({ type: "retireNewBoundary" })
    expect(timeline.getSnapshot().items.some((item) => item.kind === "divider" && item.newDivider)).toBe(false)

    timeline.dispatch({
      type: "reconcileNetwork",
      payload: {
        pages: [{ messages: [canonical({ id: "m1", seq: 1 }), canonical({ id: "m2", seq: 2 })], latestSeq: 2 }],
        readSnapshot: readState({ lastReadMessageId: "m2", lastReadSeq: 2 }),
        newBoundary: { afterSeq: 1, target: { id: "m2", channelId: "ch_alpha", seq: 2, authorId: "u_alice" } },
      },
    })
    expect(timeline.getSnapshot().items.some((item) => item.kind === "divider" && item.newDivider)).toBe(false)
  })

  it("merges out-of-order pages deterministically by seq and deduplicates by id", () => {
    const merged = mergeTimelinePages([
      { messages: [canonical({ id: "m3", seq: 3 }), canonical({ id: "m2", seq: 2 })] },
      { messages: [canonical({ id: "m1", seq: 1 }), canonical({ id: "m2", seq: 2 })] },
    ])
    expect(merged.map((message) => message.id)).toEqual(["m1", "m2", "m3"])
  })
})
