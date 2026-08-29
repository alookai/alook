import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"

const apiFetch = vi.hoisted(() => vi.fn())
const reconcileAccountReadState = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

vi.mock("./community-ws/read-state-reconciliation", () => ({
  reconcileAccountReadState: (...args: unknown[]) => reconcileAccountReadState(...args),
}))

import {
  confirmReadSurface,
  disposeReadCoordinator,
  flushPendingReadIntents,
  getReadCoordinator,
  projectReadCoordinatorSnapshot,
  READ_COORDINATOR_DEBOUNCE_MS,
  registerReadSurface,
  releaseReadSurface,
  resumeReadCoordinator,
  submitReadIntent,
  submitReadIntentGeneration,
} from "./read-coordinator"
import {
  activateInboxProjectionTicket,
  inboxReadCandidateFingerprint,
  registerInboxProjectionTicket,
  registerInboxReadReservationSurface,
  reserveInboxUnreadsResponse,
  type InboxRowTarget,
} from "./inbox-read-reservation"
import { getAccountUnreadProjection } from "./account-unread-projection"

function timelineLease(queryClient: QueryClient, confirmedSeq = 0) {
  return registerReadSurface(
    queryClient,
    "user-1",
    { kind: "timeline", channelId: "channel-1" },
    confirmedSeq,
  )
}

function submitTimeline(
  lease: ReturnType<typeof timelineLease>,
  seq: number,
) {
  return submitReadIntent(lease, {
    kind: "timeline",
    channelId: "channel-1",
    messageId: `message-${seq}`,
    seq,
  })
}

describe("read coordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    apiFetch.mockReset()
    reconcileAccountReadState.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("is an account-owned singleton and returns an unconsumed flush before and after disposal", async () => {
    const queryClient = new QueryClient()
    expect(getReadCoordinator(queryClient, "user-1"))
      .toBe(getReadCoordinator(queryClient, "user-1"))
    expect(() => getReadCoordinator(queryClient, "user-2"))
      .toThrow("read coordinator owner mismatch")
    await expect(flushPendingReadIntents(queryClient)).resolves.toEqual({
      consumed: false,
      cutoff: null,
    })

    disposeReadCoordinator(queryClient)
    await expect(flushPendingReadIntents(queryClient)).resolves.toEqual({
      consumed: false,
      cutoff: null,
    })
    expect(() => getReadCoordinator(queryClient, "user-1"))
      .toThrow("read coordinator disposed")
  })

  it("coalesces a visible timeline burst to its maximum target and hands off the returned revision", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch.mockResolvedValue({ changed: false, revision: 9, targetSeq: 7 })

    expect(submitTimeline(lease, 3)).toBe(true)
    expect(submitTimeline(lease, 7)).toBe(true)
    expect(submitTimeline(lease, 5)).toBe(false)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)

    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/channels/channel-1/read",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ lastReadMessageId: "message-7" }),
        signal: expect.any(AbortSignal),
      }),
    )
    expect(reconcileAccountReadState).toHaveBeenCalledWith(queryClient, {
      awaitSurfaceMode: "inbox-dms",
      surfaceMode: "all",
      targetRevision: 9,
    })
    expect(submitTimeline(lease, 7)).toBe(false)
  })

  it("settles a queued optimistic generation when a higher target supersedes it", () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    const projection = getAccountUnreadProjection(queryClient, "user-1")
    projection.recordArrival({ channelId: "channel-1", serverId: "server-1", seq: 4 })
    const first = submitReadIntentGeneration(lease, {
      kind: "timeline",
      channelId: "channel-1",
      messageId: "message-4",
      seq: 4,
    })!
    projection.recordOptimisticRead("channel-1", 4, first)
    const second = submitReadIntentGeneration(lease, {
      kind: "timeline",
      channelId: "channel-1",
      messageId: "message-5",
      seq: 5,
    })!
    projection.recordOptimisticRead("channel-1", 5, second)

    projection.settleOptimisticRead(second, false)
    expect(projection.projectUnread("servers", "channel-1", false)).toBe(true)
  })

  it("rejects hidden submissions without accepting a target", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    vi.stubGlobal("document", { visibilityState: "hidden" })

    expect(submitTimeline(lease, 4)).toBe(false)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS * 2)
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it("does not automatically retry terminal responses", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch.mockRejectedValue(new ApiError("forbidden", 403))

    submitTimeline(lease, 4)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("rolls back the matching optimistic projection on a terminal PUT failure", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    const projection = getAccountUnreadProjection(queryClient, "user-1")
    projection.recordArrival({ channelId: "channel-1", serverId: "server-1", seq: 4 })
    const generation = submitReadIntentGeneration(lease, {
      kind: "timeline",
      channelId: "channel-1",
      messageId: "message-4",
      seq: 4,
    })!
    projection.recordOptimisticRead("channel-1", 4, generation)
    apiFetch.mockRejectedValue(new ApiError("forbidden", 403))

    expect(projection.projectUnread("servers", "channel-1", false)).toBe(false)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    expect(projection.projectUnread("servers", "channel-1", false)).toBe(true)
  })

  it("rolls back the matching optimistic projection while a transient retry waits", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    const projection = getAccountUnreadProjection(queryClient, "user-1")
    projection.recordArrival({ channelId: "channel-1", serverId: "server-1", seq: 4 })
    const generation = submitReadIntentGeneration(lease, {
      kind: "timeline",
      channelId: "channel-1",
      messageId: "message-4",
      seq: 4,
    })!
    projection.recordOptimisticRead("channel-1", 4, generation)
    apiFetch.mockRejectedValue(new ApiError("busy", 503))

    expect(projection.projectUnread("servers", "channel-1", false)).toBe(false)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    expect(apiFetch).toHaveBeenCalledOnce()
    expect(projection.projectUnread("servers", "channel-1", false)).toBe(true)
  })

  it("bounds transient retries, retains dirty intent, and resumes it later", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch
      .mockRejectedValueOnce(new ApiError("offline", 0))
      .mockRejectedValueOnce(new ApiError("busy", 503))
      .mockRejectedValueOnce(new ApiError("busy", 503))
      .mockRejectedValueOnce(new ApiError("busy", 503))
      .mockResolvedValueOnce({ changed: true, revision: 11, targetSeq: 8 })

    submitTimeline(lease, 8)
    await vi.runAllTimersAsync()
    expect(apiFetch).toHaveBeenCalledTimes(4)

    await vi.runAllTimersAsync()
    expect(apiFetch).toHaveBeenCalledTimes(4)
    resumeReadCoordinator(queryClient)
    await vi.runAllTimersAsync()
    expect(apiFetch).toHaveBeenCalledTimes(5)
    expect(reconcileAccountReadState).toHaveBeenCalledWith(queryClient, {
      awaitSurfaceMode: "inbox-dms",
      surfaceMode: "all",
      targetRevision: 11,
    })
  })

  it("lets an authoritative snapshot cancel scheduled and in-flight work", async () => {
    const scheduledClient = new QueryClient()
    const scheduledLease = timelineLease(scheduledClient)
    submitTimeline(scheduledLease, 6)
    projectReadCoordinatorSnapshot(scheduledClient, {
      readStates: [{ channelId: "channel-1", lastReadSeq: 6 }],
    })
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    expect(apiFetch).not.toHaveBeenCalled()

    const inFlightClient = new QueryClient()
    const inFlightLease = timelineLease(inFlightClient)
    let resolveRequest!: (value: unknown) => void
    apiFetch.mockReturnValueOnce(new Promise((resolve) => {
      resolveRequest = resolve
    }))
    submitTimeline(inFlightLease, 10)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    const signal = apiFetch.mock.calls[0]?.[1]?.signal as AbortSignal
    projectReadCoordinatorSnapshot(inFlightClient, {
      readStates: [{ channelId: "channel-1", lastReadSeq: 10 }],
    })
    expect(signal.aborted).toBe(true)
    resolveRequest({ changed: true, revision: 12, targetSeq: 10 })
    await Promise.resolve()
    expect(reconcileAccountReadState).not.toHaveBeenCalled()
  })

  it("preserves accepted work across a deferred StrictMode-style release and remount", async () => {
    const queryClient = new QueryClient()
    const firstLease = timelineLease(queryClient)
    apiFetch.mockResolvedValue({ changed: true, revision: 4, targetSeq: 2 })
    submitTimeline(firstLease, 2)
    releaseReadSurface(firstLease)

    const secondLease = timelineLease(queryClient)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(submitTimeline(secondLease, 2)).toBe(false)
  })

  it("flushes one accepted target on a real route release and rejects the stale lease", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch.mockResolvedValue({ changed: true, revision: 4, targetSeq: 3 })

    expect(submitTimeline(lease, 3)).toBe(true)
    releaseReadSurface(lease)
    expect(submitTimeline(lease, 4)).toBe(false)
    await vi.advanceTimersByTimeAsync(0)

    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/channels/channel-1/read",
      expect.objectContaining({ body: JSON.stringify({ lastReadMessageId: "message-3" }) }),
    )
  })

  it("cancels an uncommitted navigation-owned opener without flushing it", async () => {
    const queryClient = new QueryClient()
    const lease = registerReadSurface(
      queryClient,
      "user-1",
      { kind: "timeline", channelId: "forum-1" },
      0,
      "cancel-uncommitted",
    )
    expect(submitReadIntentGeneration(lease, {
      kind: "timeline",
      channelId: "forum-1",
      messageId: "opener-7",
      seq: 7,
    })).toBe(1)

    releaseReadSurface(lease)
    await vi.runAllTimersAsync()
    expect(apiFetch).not.toHaveBeenCalled()
    expect(submitReadIntentGeneration(lease, {
      kind: "timeline",
      channelId: "forum-1",
      messageId: "opener-8",
      seq: 8,
    })).toBeNull()
  })

  it("uses default registration semantics and confirms monotonically through the public adapter", async () => {
    const queryClient = new QueryClient()
    const lease = registerReadSurface(queryClient, "user-1", {
      kind: "timeline",
      channelId: "channel-1",
    })
    expect(submitTimeline(lease, 6)).toBe(true)
    confirmReadSurface(lease, 6)
    confirmReadSurface(lease, 2)
    expect(submitTimeline(lease, 5)).toBe(false)
    await vi.runAllTimersAsync()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it("aborts and fences an active navigation-owned mutation on release", async () => {
    const queryClient = new QueryClient()
    const lease = registerReadSurface(
      queryClient,
      "user-1",
      { kind: "timeline", channelId: "forum-1" },
      0,
      "cancel-uncommitted",
    )
    apiFetch.mockReturnValue(new Promise(() => undefined))
    submitReadIntentGeneration(lease, {
      kind: "timeline",
      channelId: "forum-1",
      messageId: "opener-7",
      seq: 7,
    })
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    const signal = apiFetch.mock.calls[0]?.[1]?.signal as AbortSignal

    releaseReadSurface(lease)

    expect(signal.aborted).toBe(true)
    expect(reconcileAccountReadState).not.toHaveBeenCalled()
  })

  it("cancels a navigation-owned retry timer and dirty generation on release", async () => {
    const queryClient = new QueryClient()
    const lease = registerReadSurface(
      queryClient,
      "user-1",
      { kind: "timeline", channelId: "forum-1" },
      0,
      "cancel-uncommitted",
    )
    apiFetch.mockRejectedValue(new ApiError("busy", 503))
    submitReadIntentGeneration(lease, {
      kind: "timeline",
      channelId: "forum-1",
      messageId: "opener-7",
      seq: 7,
    })
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    expect(apiFetch).toHaveBeenCalledOnce()

    releaseReadSurface(lease)
    await vi.runAllTimersAsync()

    expect(apiFetch).toHaveBeenCalledOnce()
  })

  it("serializes a newer visible target behind the active request", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    let resolveFirst!: (value: unknown) => void
    apiFetch
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveFirst = resolve
      }))
      .mockResolvedValueOnce({ changed: true, revision: 6, targetSeq: 8 })

    submitTimeline(lease, 3)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    submitTimeline(lease, 8)
    expect(apiFetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(100)
    resolveFirst({ changed: true, revision: 5, targetSeq: 3 })
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(399)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(apiFetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ lastReadMessageId: "message-8" }),
    }))
  })

  it("aborts and fences an in-flight completion on account disposal", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    let resolveRequest!: (value: unknown) => void
    apiFetch.mockReturnValue(new Promise((resolve) => {
      resolveRequest = resolve
    }))

    submitTimeline(lease, 4)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    const signal = apiFetch.mock.calls[0]?.[1]?.signal as AbortSignal
    disposeReadCoordinator(queryClient)
    expect(signal.aborted).toBe(true)

    resolveRequest({ changed: true, revision: 7, targetSeq: 4 })
    await Promise.resolve()
    expect(reconcileAccountReadState).not.toHaveBeenCalled()
    expect(submitTimeline(lease, 5)).toBe(false)
  })

  it("coalesces visible forum cards through the ordinary channel transport", async () => {
    const queryClient = new QueryClient()
    const lease = registerReadSurface(queryClient, "user-1", {
      kind: "timeline",
      channelId: "forum-1",
    })
    apiFetch.mockResolvedValue({
      changed: true,
      revision: 8,
      targetSeq: 12,
    })

    expect(submitReadIntent(lease, {
      kind: "timeline",
      channelId: "forum-1",
      messageId: "opener-9",
      seq: 9,
    })).toBe(true)
    expect(submitReadIntent(lease, {
      kind: "timeline",
      channelId: "forum-1",
      messageId: "opener-12",
      seq: 12,
    })).toBe(true)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/channels/forum-1/read",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ lastReadMessageId: "opener-12" }),
        signal: expect.any(AbortSignal),
      }),
    )
    expect(submitReadIntent(lease, {
      kind: "timeline",
      channelId: "forum-1",
      messageId: "opener-9",
      seq: 9,
    })).toBe(false)
  })

  it("treats the ordinary forum channel cursor as card confirmation", async () => {
    const queryClient = new QueryClient()
    const lease = registerReadSurface(queryClient, "user-1", {
      kind: "timeline",
      channelId: "forum-1",
    })
    projectReadCoordinatorSnapshot(queryClient, {
      readStates: [{ channelId: "forum-1", lastReadSeq: 12 }],
    })
    expect(submitReadIntent(lease, {
      kind: "timeline",
      channelId: "forum-1",
      messageId: "opener-12",
      seq: 12,
    })).toBe(false)
    await vi.runAllTimersAsync()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it("absorbs reconciliation failures after a committed read response", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch.mockResolvedValue({ changed: true, revision: 14, targetSeq: 4 })
    reconcileAccountReadState.mockRejectedValue(new Error("snapshot unavailable"))

    submitTimeline(lease, 4)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    await Promise.resolve()

    expect(apiFetch).toHaveBeenCalledOnce()
    expect(reconcileAccountReadState).toHaveBeenCalledWith(queryClient, {
      awaitSurfaceMode: "inbox-dms",
      surfaceMode: "all",
      targetRevision: 14,
    })
  })

  it("cancels a queued transient retry when a snapshot confirms its target", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch.mockRejectedValue(new ApiError("busy", 503))

    submitTimeline(lease, 6)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    expect(apiFetch).toHaveBeenCalledOnce()

    projectReadCoordinatorSnapshot(queryClient, {
      readStates: [{ channelId: "channel-1", lastReadSeq: 6 }],
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(apiFetch).toHaveBeenCalledOnce()
  })

  it("flushes accepted work before its debounce and consumes only after reconciliation", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch.mockResolvedValue({ changed: true, revision: 15, targetSeq: 4 })

    submitTimeline(lease, 4)
    const work = flushPendingReadIntents(queryClient)
    expect(apiFetch).toHaveBeenCalledOnce()
    await expect(work).resolves.toEqual({ consumed: true, cutoff: 1 })
    expect(reconcileAccountReadState).toHaveBeenCalledWith(queryClient, {
      awaitSurfaceMode: "inbox-dms",
      surfaceMode: "all",
      targetRevision: 15,
    })
  })

  it("joins an active attempt and drains only work accepted by its cutoff", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    let resolveFirst!: (value: unknown) => void
    apiFetch
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ changed: true, revision: 17, targetSeq: 8 })

    submitTimeline(lease, 3)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    submitTimeline(lease, 8)
    const work = flushPendingReadIntents(queryClient)
    resolveFirst({ changed: true, revision: 16, targetSeq: 3 })

    await expect(work).resolves.toEqual({ consumed: true, cutoff: 2 })
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(apiFetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ lastReadMessageId: "message-8" }),
    }))
  })

  it("freezes the cutoff and preserves a later intent's original debounce", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    let resolvePut!: (value: unknown) => void
    let resolveReconcile!: () => void
    apiFetch
      .mockReturnValueOnce(new Promise((resolve) => { resolvePut = resolve }))
      .mockResolvedValueOnce({ changed: true, revision: 19, targetSeq: 9 })
    reconcileAccountReadState
      .mockReturnValueOnce(new Promise<void>((resolve) => { resolveReconcile = resolve }))
      .mockResolvedValue(undefined)

    submitTimeline(lease, 3)
    const firstFlush = flushPendingReadIntents(queryClient)
    submitTimeline(lease, 6)
    await vi.advanceTimersByTimeAsync(100)
    resolvePut({ changed: true, revision: 18, targetSeq: 3 })
    await vi.waitFor(() => expect(reconcileAccountReadState).toHaveBeenCalledOnce())
    submitTimeline(lease, 9)
    resolveReconcile()

    await expect(firstFlush).resolves.toEqual({
      consumed: false,
      cutoff: 1,
      deferred: true,
    })
    expect(reconcileAccountReadState).toHaveBeenCalledWith(queryClient, {
      awaitSurfaceMode: "none",
      surfaceMode: "non-inbox",
      targetRevision: 18,
    })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(apiFetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ lastReadMessageId: "message-9" }),
    }))
  })

  it("defers Inbox/DM when the owner already queued a later generation", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch.mockResolvedValue({ changed: true, revision: 20, targetSeq: 4 })

    submitTimeline(lease, 4)
    const work = flushPendingReadIntents(queryClient, {
      deferInboxDms: () => true,
    })

    await expect(work).resolves.toEqual({
      consumed: false,
      cutoff: 1,
      deferred: true,
    })
    expect(reconcileAccountReadState).toHaveBeenCalledWith(queryClient, {
      awaitSurfaceMode: "none",
      surfaceMode: "non-inbox",
      targetRevision: 20,
    })
  })

  it("returns an unconsumed result without waiting through retry backoff", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch.mockRejectedValue(new ApiError("busy", 503))

    submitTimeline(lease, 4)
    await expect(flushPendingReadIntents(queryClient)).resolves.toEqual({
      consumed: false,
      cutoff: 1,
    })
    expect(apiFetch).toHaveBeenCalledOnce()
  })

  it("returns unconsumed when a joined active attempt fails", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    let rejectRequest!: (error: unknown) => void
    apiFetch.mockReturnValue(new Promise((_resolve, reject) => {
      rejectRequest = reject
    }))

    submitTimeline(lease, 4)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    const work = flushPendingReadIntents(queryClient)
    rejectRequest(new ApiError("busy", 503))

    await expect(work).resolves.toEqual({ consumed: false, cutoff: 1 })
    expect(apiFetch).toHaveBeenCalledOnce()
  })

  it("fences a rejected mutation completion after disposal", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    let rejectRequest!: (error: unknown) => void
    apiFetch.mockReturnValue(new Promise((_resolve, reject) => {
      rejectRequest = reject
    }))

    submitTimeline(lease, 4)
    await vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS)
    disposeReadCoordinator(queryClient)
    rejectRequest(new Error("aborted"))
    await vi.waitFor(() => expect(reconcileAccountReadState).not.toHaveBeenCalled())
  })

  it("does not consume a committed read whose authoritative refresh fails", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch.mockResolvedValue({ changed: true, revision: 20, targetSeq: 4 })
    reconcileAccountReadState.mockRejectedValue(new Error("surface refresh failed"))

    submitTimeline(lease, 4)
    await expect(flushPendingReadIntents(queryClient)).resolves.toEqual({
      consumed: false,
      cutoff: 1,
    })
  })

  it("publishes success only after the owned Inbox reconciliation settles", async () => {
    const queryClient = new QueryClient()
    const data = {
      servers: [{
        serverId: "s1",
        channels: [{
          channelId: "channel-1",
          lastMessageAt: "2026-08-27T01:00:00.000Z",
          hasDirectUnread: true,
          children: [],
        }],
      }],
      dms: [],
    }
    queryClient.setQueryData(communityKeys.inboxUnreads(), data)
    const target: InboxRowTarget = {
      kind: "channel-direct",
      identity: JSON.stringify(["channel-direct", "s1", "channel-1"]),
      fingerprint: inboxReadCandidateFingerprint({
        channelId: "channel-1",
        lastMessageAt: "2026-08-27T01:00:00.000Z",
        openerUnread: false,
      }),
      confirmationChannelId: "channel-1",
      serverId: "s1",
      channelId: "channel-1",
    }
    const receipt = vi.fn()
    activateInboxProjectionTicket(registerInboxProjectionTicket(
      queryClient,
      1,
      target,
      receipt,
    ))
    const reservation = registerInboxReadReservationSurface(
      queryClient,
      "channel-1",
      vi.fn(),
    )
    const pending = reserveInboxUnreadsResponse(queryClient, data)
    void pending.catch(() => undefined)
    const readLease = timelineLease(queryClient)
    const generation = submitReadIntentGeneration(readLease, {
      kind: "timeline",
      channelId: "channel-1",
      messageId: "message-4",
      seq: 4,
    })!
    const { promoteInboxReadReservation } = await import("./inbox-read-reservation")
    promoteInboxReadReservation(reservation, generation)
    apiFetch.mockResolvedValue({ changed: true, revision: 20, targetSeq: 4 })
    let resolveReconciliation!: () => void
    reconcileAccountReadState.mockReturnValue(new Promise<void>((resolve) => {
      resolveReconciliation = resolve
    }))

    const work = flushPendingReadIntents(queryClient)
    await vi.waitFor(() => expect(reconcileAccountReadState).toHaveBeenCalled())
    expect(receipt).not.toHaveBeenCalled()
    queryClient.setQueryData(communityKeys.inboxUnreads(), { servers: [], dms: [] })
    resolveReconciliation()
    await expect(work).resolves.toEqual({ consumed: true, cutoff: generation })
    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
      terminal: "success",
      disposition: "retire",
    }))
  })

  it("publishes deferred and reconciliation-error receipts as deterministic rollback", async () => {
    const run = async (mode: "deferred" | "error") => {
      const queryClient = new QueryClient()
      const data = {
        servers: [{
          serverId: "s1",
          channels: [{
            channelId: "channel-1",
            lastMessageAt: "2026-08-27T01:00:00.000Z",
            hasDirectUnread: true,
            children: [],
          }],
        }],
        dms: [],
      }
      queryClient.setQueryData(communityKeys.inboxUnreads(), data)
      const target: InboxRowTarget = {
        kind: "channel-direct",
        identity: JSON.stringify(["channel-direct", "s1", "channel-1"]),
        fingerprint: inboxReadCandidateFingerprint({
          channelId: "channel-1",
          lastMessageAt: "2026-08-27T01:00:00.000Z",
          openerUnread: false,
        }),
        confirmationChannelId: "channel-1",
        serverId: "s1",
        channelId: "channel-1",
      }
      const receipt = vi.fn()
      activateInboxProjectionTicket(registerInboxProjectionTicket(
        queryClient,
        1,
        target,
        receipt,
      ))
      const reservation = registerInboxReadReservationSurface(
        queryClient,
        "channel-1",
        vi.fn(),
      )
      const pending = reserveInboxUnreadsResponse(queryClient, data)
      void pending.catch(() => undefined)
      const readLease = timelineLease(queryClient)
      const generation = submitReadIntentGeneration(readLease, {
        kind: "timeline",
        channelId: "channel-1",
        messageId: "message-4",
        seq: 4,
      })!
      const { promoteInboxReadReservation } = await import("./inbox-read-reservation")
      promoteInboxReadReservation(reservation, generation)
      apiFetch.mockResolvedValue({ changed: true, revision: 20, targetSeq: 4 })
      if (mode === "error") {
        reconcileAccountReadState.mockRejectedValue(new Error("refresh failed"))
      }
      await flushPendingReadIntents(queryClient, mode === "deferred"
        ? { deferInboxDms: () => true }
        : undefined)
      expect(receipt).toHaveBeenCalledWith(expect.objectContaining({
        terminal: mode,
        disposition: "rollback",
        observedFingerprint: null,
      }))
    }
    await run("deferred")
    apiFetch.mockReset()
    reconcileAccountReadState.mockReset().mockResolvedValue(undefined)
    await run("error")
  })
})
