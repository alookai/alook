import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

import {
  disposeAccountReadStateReconciliation,
  projectReadStateEnvelope,
  reconcileAccountReadState,
  type AccountReadStateSnapshot,
} from "./read-state-reconciliation"

describe("account read-state reconciliation", () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useRealTimers()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    apiFetch.mockReset()
  })

  it("treats every newer bounded hint as an authoritative-snapshot gap", () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 6,
      readStates: [],
    })
    expect(projectReadStateEnvelope(queryClient, {
      revision: 6,
      inboxChanged: true,
    })).toBe("stale")
    expect(projectReadStateEnvelope(queryClient, {
      revision: 7,
      inboxChanged: true,
    })).toBe("gap")
    expect(projectReadStateEnvelope(queryClient, {
      revision: 8,
      inboxChanged: true,
    })).toBe("gap")
    queryClient.removeQueries({ queryKey: communityKeys.accountReadStateSnapshot() })
    expect(projectReadStateEnvelope(queryClient, {
      revision: 1,
      inboxChanged: true,
    })).toBe("gap")
  })

  it("loads the authoritative full replacement, including regression and removal", async () => {
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("c1"), { lastReadSeq: 1 })
    queryClient.setQueryData(communityKeys.dmReadStateSnapshot("dm1"), { lastReadSeq: 2 })
    apiFetch.mockResolvedValue({
      revision: 10,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m0",
        lastReadAt: "2026-08-24T00:00:00.000Z",
        lastReadSeq: 0,
      }],
    })

    await reconcileAccountReadState(queryClient, { invalidateSurfaces: false })
    expect(apiFetch).toHaveBeenCalledWith("/api/community/users/me/read-state", expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1"))).toMatchObject({
      lastReadMessageId: "m0",
      lastReadSeq: 0,
    })
    expect(queryClient.getQueryData(communityKeys.dmReadStateSnapshot("dm1"))).toEqual({
      lastReadMessageId: null,
      lastReadAt: null,
      lastReadSeq: 0,
    })
  })

  it("reprojects leaf caches when a lifecycle read returns the current revision", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 10,
      readStates: [],
    })
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("late"), {
      lastReadMessageId: null,
      lastReadAt: null,
      lastReadSeq: 0,
    })
    apiFetch.mockResolvedValue({
      revision: 10,
      readStates: [{
        channelId: "late",
        lastReadMessageId: "m3",
        lastReadAt: "2026-08-24T00:00:03.000Z",
        lastReadSeq: 3,
      }],
    })

    await reconcileAccountReadState(queryClient, { invalidateSurfaces: false })

    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("late")))
      .toMatchObject({ lastReadMessageId: "m3", lastReadSeq: 3 })
  })

  it("invalidates every cached concrete server detail after applying a snapshot", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 1,
      readStates: [],
    })
    queryClient.setQueryData(communityKeys.server("server-1"), { id: "server-1" })
    apiFetch.mockResolvedValue({ revision: 2, readStates: [] })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    await reconcileAccountReadState(queryClient, { targetRevision: 2 })

    expect(invalidate).toHaveBeenCalledWith(
      { queryKey: communityKeys.server("server-1"), exact: true, refetchType: "active" },
      { throwOnError: true, cancelRefetch: true },
    )
  })

  it("deduplicates concurrent lifecycle and gap reconciliations per query client", async () => {
    let release!: (snapshot: AccountReadStateSnapshot) => void
    apiFetch.mockReturnValue(new Promise<AccountReadStateSnapshot>((resolve) => {
      release = resolve
    }))

    const first = reconcileAccountReadState(queryClient, { invalidateSurfaces: false })
    const second = reconcileAccountReadState(queryClient, { invalidateSurfaces: false })
    expect(apiFetch).toHaveBeenCalledTimes(1)

    release({ revision: 3, readStates: [] })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { revision: 3, readStates: [] },
      { revision: 3, readStates: [] },
    ])
  })

  it("does not lose a live revision behind a cold auth snapshot in flight", async () => {
    let releaseAuth!: (snapshot: AccountReadStateSnapshot) => void
    let releaseFresh!: (snapshot: AccountReadStateSnapshot) => void
    apiFetch
      .mockReturnValueOnce(new Promise<AccountReadStateSnapshot>((resolve) => {
        releaseAuth = resolve
      }))
      .mockReturnValueOnce(new Promise<AccountReadStateSnapshot>((resolve) => {
        releaseFresh = resolve
      }))
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("c1"), { lastReadSeq: 0 })
    queryClient.setQueryData(communityKeys.dmReadStateSnapshot("removed"), { lastReadSeq: 4 })

    const auth = reconcileAccountReadState(queryClient, { invalidateSurfaces: false })
    expect(projectReadStateEnvelope(queryClient, {
      revision: 5,
      inboxChanged: true,
    })).toBe("gap")
    const live = reconcileAccountReadState(queryClient, {
      invalidateSurfaces: false,
      targetRevision: 5,
    })
    expect(apiFetch).toHaveBeenCalledTimes(1)

    releaseAuth({ revision: 4, readStates: [] })
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))
    releaseFresh({
      revision: 5,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m5",
        lastReadAt: "2026-08-24T00:00:05.000Z",
        lastReadSeq: 5,
      }],
    })

    await expect(Promise.all([auth, live])).resolves.toEqual([
      {
        revision: 5,
        readStates: [{
          channelId: "c1",
          lastReadMessageId: "m5",
          lastReadAt: "2026-08-24T00:00:05.000Z",
          lastReadSeq: 5,
        }],
      },
      {
        revision: 5,
        readStates: [{
          channelId: "c1",
          lastReadMessageId: "m5",
          lastReadAt: "2026-08-24T00:00:05.000Z",
          lastReadSeq: 5,
        }],
      },
    ])
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1"))).toMatchObject({
      lastReadMessageId: "m5",
      lastReadSeq: 5,
    })
    expect(queryClient.getQueryData(communityKeys.dmReadStateSnapshot("removed"))).toEqual({
      lastReadMessageId: null,
      lastReadAt: null,
      lastReadSeq: 0,
    })
  })

  it("immediately refetches when a successful snapshot remains below the live target", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 4,
      readStates: [],
    })
    apiFetch
      .mockResolvedValueOnce({ revision: 4, readStates: [] })
      .mockResolvedValueOnce({ revision: 5, readStates: [] })

    await expect(reconcileAccountReadState(queryClient, {
      invalidateSurfaces: false,
      targetRevision: 5,
    })).resolves.toEqual({ revision: 5, readStates: [] })

    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it("retains a live target after a transient snapshot failure and lets a later caller take over", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 4,
      readStates: [],
    })
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("c1"), {
      lastReadMessageId: null,
      lastReadAt: null,
      lastReadSeq: 0,
    })
    apiFetch
      .mockRejectedValueOnce(new Error("temporary primary failure"))
      .mockResolvedValueOnce({
        revision: 5,
        readStates: [{
          channelId: "c1",
          lastReadMessageId: "m5",
          lastReadAt: "2026-08-24T00:00:05.000Z",
          lastReadSeq: 5,
        }],
      })

    await expect(reconcileAccountReadState(queryClient, {
      invalidateSurfaces: false,
      targetRevision: 5,
    })).rejects.toThrow("temporary primary failure")

    await expect(reconcileAccountReadState(queryClient, {
      invalidateSurfaces: false,
      targetRevision: 5,
    })).resolves.toMatchObject({ revision: 5 })
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1")))
      .toMatchObject({ lastReadSeq: 5 })
  })

  it("automatically retries a retained target after the bounded initial backoff", async () => {
    vi.useFakeTimers()
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 4,
      readStates: [],
    })
    apiFetch
      .mockRejectedValueOnce(new Error("temporary primary failure"))
      .mockResolvedValueOnce({ revision: 5, readStates: [] })

    await expect(reconcileAccountReadState(queryClient, {
      invalidateSurfaces: false,
      targetRevision: 5,
    })).rejects.toThrow("temporary primary failure")
    expect(apiFetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => expect(queryClient.getQueryData(
      communityKeys.accountReadStateSnapshot(),
    )).toMatchObject({ revision: 5 }))
    expect(apiFetch).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it("cancels retained retry work on exit without another GET or projection", async () => {
    vi.useFakeTimers()
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 4,
      readStates: [],
    })
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("c1"), {
      lastReadMessageId: null,
      lastReadAt: null,
      lastReadSeq: 0,
    })
    apiFetch
      .mockRejectedValueOnce(new Error("temporary primary failure"))
      .mockResolvedValueOnce({
        revision: 5,
        readStates: [{
          channelId: "c1",
          lastReadMessageId: "m5",
          lastReadAt: "2026-08-24T00:00:05.000Z",
          lastReadSeq: 5,
        }],
      })

    await expect(reconcileAccountReadState(queryClient, {
      invalidateSurfaces: false,
      targetRevision: 5,
    })).rejects.toThrow("temporary primary failure")
    disposeAccountReadStateReconciliation(queryClient)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(communityKeys.accountReadStateSnapshot()))
      .toMatchObject({ revision: 4 })
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1")))
      .toMatchObject({ lastReadSeq: 0 })
    await expect(reconcileAccountReadState(queryClient, {
      targetRevision: 5,
    })).rejects.toThrow("account read-state reconciliation disposed")
    vi.useRealTimers()
  })

  it("aborts and fences an active primary request on exit", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 4,
      readStates: [],
    })
    let release!: (snapshot: AccountReadStateSnapshot) => void
    let requestSignal: AbortSignal | undefined
    apiFetch.mockImplementationOnce((_path: string, options: { signal?: AbortSignal }) => {
      requestSignal = options.signal
      return new Promise<AccountReadStateSnapshot>((resolve) => {
        release = resolve
      })
    })

    const worker = reconcileAccountReadState(queryClient, {
      invalidateSurfaces: false,
      targetRevision: 5,
    })
    expect(requestSignal?.aborted).toBe(false)
    disposeAccountReadStateReconciliation(queryClient)
    expect(requestSignal?.aborted).toBe(true)
    release({ revision: 5, readStates: [] })

    await expect(worker).rejects.toThrow("account read-state reconciliation disposed")
    expect(queryClient.getQueryData(communityKeys.accountReadStateSnapshot()))
      .toMatchObject({ revision: 4 })
  })

  it("retains a real active-query refetch failure until same-revision takeover succeeds", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 4,
      readStates: [],
    })
    apiFetch.mockResolvedValue({
      revision: 5,
      readStates: [],
    })
    let inboxFetches = 0
    const inboxObserver = new QueryObserver(queryClient, {
      queryKey: communityKeys.inbox(),
      queryFn: async () => {
        inboxFetches += 1
        if (inboxFetches === 2) throw new Error("temporary inbox failure")
        return []
      },
    })
    const unsubscribe = inboxObserver.subscribe(() => undefined)
    await vi.waitFor(() => expect(inboxObserver.getCurrentResult().status).toBe("success"))

    await expect(reconcileAccountReadState(queryClient, {
      targetRevision: 5,
    })).rejects.toThrow("read-state surface reconciliation failed")
    expect(queryClient.getQueryData(communityKeys.accountReadStateSnapshot()))
      .toMatchObject({ revision: 5 })
    expect(projectReadStateEnvelope(queryClient, {
      revision: 5,
      inboxChanged: true,
    })).toBe("gap")

    await expect(reconcileAccountReadState(queryClient, {
      targetRevision: 5,
    })).resolves.toMatchObject({ revision: 5 })
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(inboxFetches).toBe(3)
    expect(inboxObserver.getCurrentResult()).toMatchObject({
      status: "success",
      data: [],
    })
    expect(projectReadStateEnvelope(queryClient, {
      revision: 5,
      inboxChanged: true,
    })).toBe("stale")
    unsubscribe()
  })

  it("coalesces repeated live hints into one retry worker without a request storm", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 4,
      readStates: [],
    })
    let release!: (snapshot: AccountReadStateSnapshot) => void
    apiFetch.mockReturnValue(new Promise<AccountReadStateSnapshot>((resolve) => {
      release = resolve
    }))

    const workers = Array.from({ length: 12 }, () => reconcileAccountReadState(queryClient, {
      invalidateSurfaces: false,
      targetRevision: 5,
    }))
    expect(apiFetch).toHaveBeenCalledTimes(1)
    release({ revision: 5, readStates: [] })
    await expect(Promise.all(workers)).resolves.toHaveLength(12)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("lets post-PUT consumption finish on Inbox/DM while server retry stays independent", async () => {
    vi.useFakeTimers()
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 4,
      readStates: [],
    })
    apiFetch.mockResolvedValue({ revision: 5, readStates: [] })

    let inboxFetches = 0
    const inboxObserver = new QueryObserver(queryClient, {
      queryKey: communityKeys.inbox(),
      queryFn: async () => {
        inboxFetches += 1
        return []
      },
    })
    const unsubscribeInbox = inboxObserver.subscribe(() => undefined)

    let serverFetches = 0
    const serverObserver = new QueryObserver(queryClient, {
      queryKey: communityKeys.server("server-1"),
      queryFn: async () => {
        serverFetches += 1
        if (serverFetches === 2) throw new Error("temporary server detail failure")
        return { id: "server-1" }
      },
    })
    const unsubscribeServer = serverObserver.subscribe(() => undefined)
    await Promise.all([
      vi.waitFor(() => expect(inboxObserver.getCurrentResult().status).toBe("success")),
      vi.waitFor(() => expect(serverObserver.getCurrentResult().status).toBe("success")),
    ])

    await expect(reconcileAccountReadState(queryClient, {
      surfaceMode: "all",
      awaitSurfaceMode: "inbox-dms",
      targetRevision: 5,
    })).resolves.toMatchObject({ revision: 5 })
    await vi.waitFor(() => expect(serverFetches).toBe(2))
    expect(inboxFetches).toBe(2)
    expect(projectReadStateEnvelope(queryClient, {
      revision: 5,
      inboxChanged: true,
    })).toBe("stale")

    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() => expect(serverFetches).toBe(3))
    expect(inboxFetches).toBe(2)

    unsubscribeInbox()
    unsubscribeServer()
    vi.useRealTimers()
  })

  it("advances the snapshot and runs a second derived pass during invalidation", async () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 4,
      readStates: [],
    })
    apiFetch
      .mockResolvedValueOnce({ revision: 5, readStates: [] })
      .mockResolvedValueOnce({ revision: 6, readStates: [] })
    let releaseSurface!: () => void
    const surfaceGate = new Promise<void>((resolve) => {
      releaseSurface = resolve
    })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    invalidate.mockReturnValueOnce(surfaceGate).mockResolvedValue(undefined)

    const first = reconcileAccountReadState(queryClient, { targetRevision: 5 })
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3))
    const second = reconcileAccountReadState(queryClient, { targetRevision: 6 })
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2))

    releaseSurface()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { revision: 6, readStates: [] },
      { revision: 6, readStates: [] },
    ])
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledTimes(6)
  })
})
