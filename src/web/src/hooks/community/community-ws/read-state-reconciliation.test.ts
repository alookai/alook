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

  it("applies only the exact next revision and keeps the maximum seq", () => {
    const snapshot: AccountReadStateSnapshot = {
      revision: 4,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m9",
        lastReadAt: "2026-08-24T00:00:09.000Z",
        lastReadSeq: 9,
      }],
    }
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), snapshot)
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("c1"), {
      lastReadMessageId: "m9",
      lastReadAt: "2026-08-24T00:00:09.000Z",
      lastReadSeq: 9,
    })

    expect(projectReadStateEnvelope(queryClient, {
      revision: 5,
      advances: [{
        channelId: "c1",
        lastReadMessageId: "m7",
        lastReadAt: "2026-08-24T00:00:07.000Z",
        lastReadSeq: 7,
      }],
      inboxChanged: true,
    })).toBe("applied")
    expect(queryClient.getQueryData<AccountReadStateSnapshot>(
      communityKeys.accountReadStateSnapshot(),
    )).toEqual({ ...snapshot, revision: 5 })
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1"))).toMatchObject({
      lastReadMessageId: "m9",
      lastReadSeq: 9,
    })
  })

  it("ignores stale revisions and reports unknown or skipped revisions as gaps", () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 6,
      readStates: [],
    })
    const advance = {
      channelId: "c1",
      lastReadMessageId: "m1",
      lastReadAt: "2026-08-24T00:00:01.000Z",
      lastReadSeq: 1,
    }
    expect(projectReadStateEnvelope(queryClient, {
      revision: 6,
      advances: [advance],
      inboxChanged: true,
    })).toBe("stale")
    expect(projectReadStateEnvelope(queryClient, {
      revision: 8,
      advances: [advance],
      inboxChanged: true,
    })).toBe("gap")
    queryClient.removeQueries({ queryKey: communityKeys.accountReadStateSnapshot() })
    expect(projectReadStateEnvelope(queryClient, {
      revision: 1,
      advances: [advance],
      inboxChanged: true,
    })).toBe("gap")
  })

  it("applies every advance in one exact-next read-all envelope", () => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 2,
      readStates: [],
    })
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("c1"), { lastReadSeq: 0 })
    queryClient.setQueryData(communityKeys.dmReadStateSnapshot("dm1"), { lastReadSeq: 0 })

    expect(projectReadStateEnvelope(queryClient, {
      revision: 3,
      advances: [{
        channelId: "c1",
        lastReadMessageId: "m4",
        lastReadAt: "2026-08-24T00:00:04.000Z",
        lastReadSeq: 4,
      }, {
        channelId: "dm1",
        lastReadMessageId: "m8",
        lastReadAt: "2026-08-24T00:00:08.000Z",
        lastReadSeq: 8,
      }],
      inboxChanged: true,
    })).toBe("applied")
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1"))).toMatchObject({
      lastReadMessageId: "m4",
      lastReadSeq: 4,
    })
    expect(queryClient.getQueryData(communityKeys.dmReadStateSnapshot("dm1"))).toMatchObject({
      lastReadMessageId: "m8",
      lastReadSeq: 8,
    })
  })

  it("loads the authoritative snapshot and projects cached channel and DM rows", async () => {
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("c1"), { lastReadSeq: 1 })
    queryClient.setQueryData(communityKeys.dmReadStateSnapshot("dm1"), { lastReadSeq: 2 })
    apiFetch.mockResolvedValue({
      revision: 10,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m5",
        lastReadAt: "2026-08-24T00:00:05.000Z",
        lastReadSeq: 5,
      }],
    })

    await reconcileAccountReadState(queryClient, { invalidateSurfaces: false })
    expect(apiFetch).toHaveBeenCalledWith("/api/community/users/me/read-state", expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1"))).toMatchObject({
      lastReadMessageId: "m5",
      lastReadSeq: 5,
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

  it("drops a delayed snapshot after a newer exact-next event is applied", async () => {
    let release!: (snapshot: AccountReadStateSnapshot) => void
    apiFetch.mockReturnValue(new Promise<AccountReadStateSnapshot>((resolve) => {
      release = resolve
    }))
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), {
      revision: 6,
      readStates: [],
    })
    queryClient.setQueryData(communityKeys.channelReadStateSnapshot("c1"), { lastReadSeq: 0 })

    const reconciliation = reconcileAccountReadState(queryClient, { invalidateSurfaces: false })
    expect(projectReadStateEnvelope(queryClient, {
      revision: 7,
      advances: [{
        channelId: "c1",
        lastReadMessageId: "m7",
        lastReadAt: "2026-08-24T00:00:07.000Z",
        lastReadSeq: 7,
      }],
      inboxChanged: true,
    })).toBe("applied")
    release({
      revision: 6,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m3",
        lastReadAt: "2026-08-24T00:00:03.000Z",
        lastReadSeq: 3,
      }],
    })

    await expect(reconciliation).resolves.toMatchObject({ revision: 7 })
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1"))).toMatchObject({
      lastReadMessageId: "m7",
      lastReadSeq: 7,
    })
  })
})
