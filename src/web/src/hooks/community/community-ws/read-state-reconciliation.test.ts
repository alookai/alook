import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

import {
  projectReadStateEnvelope,
  reconcileAccountReadState,
  type AccountReadStateSnapshot,
} from "./read-state-reconciliation"

describe("account read-state reconciliation", () => {
  let queryClient: QueryClient

  beforeEach(() => {
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
      { revision: 4, readStates: [] },
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
})
