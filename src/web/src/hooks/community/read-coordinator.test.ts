import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/errors"

const apiFetch = vi.hoisted(() => vi.fn())
const reconcileAccountReadState = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

vi.mock("./community-ws/read-state-reconciliation", () => ({
  reconcileAccountReadState: (...args: unknown[]) => reconcileAccountReadState(...args),
}))

import {
  disposeReadCoordinator,
  flushPendingReadIntents,
  getReadCoordinator,
  projectReadCoordinatorSnapshot,
  READ_COORDINATOR_DEBOUNCE_MS,
  registerReadSurface,
  releaseReadSurface,
  resumeReadCoordinator,
  submitReadIntent,
} from "./read-coordinator"

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

  it("is an account-owned singleton and cannot be rebuilt after disposal", () => {
    const queryClient = new QueryClient()
    expect(getReadCoordinator(queryClient, "user-1"))
      .toBe(getReadCoordinator(queryClient, "user-1"))
    expect(() => getReadCoordinator(queryClient, "user-2"))
      .toThrow("read coordinator owner mismatch")

    disposeReadCoordinator(queryClient)
    expect(() => getReadCoordinator(queryClient, "user-1"))
      .toThrow("read coordinator disposed")
  })

  it("coalesces a visible timeline burst to its maximum target and hands off the returned revision", async () => {
    const queryClient = new QueryClient()
    const lease = timelineLease(queryClient)
    apiFetch.mockResolvedValue({ changed: false, revision: 9, targetSeq: 7 })

    expect(submitTimeline(lease, 3)).toBe(true)
    expect(submitTimeline(lease, 7)).toBe(true)
    expect(submitTimeline(lease, 5)).toBe(true)
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

    resolveFirst({ changed: true, revision: 5, targetSeq: 3 })
    await vi.runAllTimersAsync()

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
})
