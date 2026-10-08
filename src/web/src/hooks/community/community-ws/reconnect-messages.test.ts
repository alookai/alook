import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { messageWindowPage, type MessagesPage } from "@/lib/community/models/message"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import { ApiError } from "@/lib/errors"
import {
  reconcileFocusedMessageQueries,
  scheduleFocusedMessageGapRepair,
} from "./reconnect-messages"

const apiFetchMock = vi.hoisted(() => vi.fn())
const captureCommunityLiveSnapshotTokenMock = vi.hoisted(() => vi.fn())
const publishCommunityMessagesMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

vi.mock("@/lib/community-db/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/community-db/sync")>()
  captureCommunityLiveSnapshotTokenMock.mockImplementation(actual.captureCommunityLiveSnapshotToken)
  publishCommunityMessagesMock.mockImplementation(actual.publishCommunityMessages)
  return {
  ...actual,
  captureCommunityLiveSnapshotToken: (...args: unknown[]) => (
    captureCommunityLiveSnapshotTokenMock(...args)
  ),
  publishCommunityMessages: (...args: unknown[]) => publishCommunityMessagesMock(...args),
  }
})

function seedActiveQuery(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
) {
  const data = {
    pages: [
      {
        messages: [{
          id: "m_2",
          type: "chat",
          seq: 2,
          createdAt: "2026-08-15T00:00:02.000Z",
        }],
        hasMore: true,
        cursor: "older-2",
        latestSeq: 2,
      },
      {
        messages: [{
          id: "m_1",
          type: "chat",
          seq: 1,
          createdAt: "2026-08-15T00:00:01.000Z",
        }],
        hasMore: false,
        latestSeq: 2,
      },
    ],
    pageParams: [
      { mode: "newest" },
      { mode: "older", cursor: "older-2" },
    ],
  }
  queryClient.setQueryData(queryKey, { ...data, pages: data.pages.map((page) => messageWindowPage(page as MessagesPage)) })
  const queryFn = vi.fn(async () => ({ stale: true }))
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    staleTime: Infinity,
  })
  return { queryFn, unsubscribe: observer.subscribe(() => undefined) }
}

function seedEmptyActiveQuery(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
) {
  queryClient.setQueryData(queryKey, {
    pages: [{
      messages: [],
      hasMore: false,
      latestSeq: 0,
    }],
    pageParams: [{ mode: "newest" }],
  })
  const queryFn = vi.fn(async () => ({ stale: true }))
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    staleTime: Infinity,
  })
  return { queryFn, unsubscribe: observer.subscribe(() => undefined) }
}

beforeEach(() => {
  apiFetchMock.mockReset()
  captureCommunityLiveSnapshotTokenMock.mockClear()
  publishCommunityMessagesMock.mockClear()
})

describe("focused message reconnect catch-up", () => {
  it.each(["account", "parent", "replacement"] as const)("drops old reconnect data after %s changes", async (change) => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const key = communityKeys.channelMessages("child")
    const { unsubscribe } = seedActiveQuery(queryClient, key)
    let release!: (value: unknown) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const result = reconcileFocusedMessageQueries(queryClient, "channel", "child")
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    const state = getCommunityRuntime(queryClient).ws.get()
    if (change === "account") {
      getCommunityRuntime(queryClient).ws.actions.activateProfileAccount("b")
      getCommunityRuntime(queryClient).ws.actions.activateProfileAccount("a")
    } else if (change === "parent") getCommunityRuntime(queryClient).ws.actions.revokeChannelAccess("server", "parent")
    else {
      queryClient.removeQueries({ queryKey: key, exact: true })
      queryClient.setQueryData(key, { pages: [{ messages: [{ id: "new-account-message" }] }], pageParams: [] })
    }
    const expected = queryClient.getQueryData(key)
    release({ messages: [{ id: "old-reconnect-message" }], latestSeq: 2, hasMore: false })
    await result
    expect(queryClient.getQueryData(key)).toBe(expected)
    unsubscribe()
    queryClient.clear()
  })

  it.each(["channel", "dm"] as const)("shares in-flight %s window work across foreground, reconnect and gap repair", async (kind) => {
    const { client: client } = await createCommunityQueryOwner("a")
    const key = kind === "channel" ? communityKeys.channelMessages("shared") : communityKeys.dmMessages("shared")
    const { unsubscribe } = seedActiveQuery(client, key)
    let release!: (page: unknown) => void
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const cancel = vi.spyOn(client, "cancelQueries")
    const first = reconcileFocusedMessageQueries(client, kind, "shared")
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    const reconnect = reconcileFocusedMessageQueries(client, kind, "shared")
    const gap = scheduleFocusedMessageGapRepair(client, { kind, scopeId: "shared" }, 5)
    expect(client.getQueryCache().find({ queryKey: [...key, "reconcile"], exact: true })?.state.fetchStatus).toBe("fetching")
    expect(cancel).toHaveBeenCalledOnce()
    expect(apiFetchMock).toHaveBeenCalledOnce()
    apiFetchMock.mockResolvedValueOnce({ messages: [3, 4, 5].map((seq) => ({ id: `m_${seq}`, seq, createdAt: `2026-08-15T00:00:0${seq}.000Z` })), latestSeq: 5, hasMoreNewer: false })
    release({ messages: [], latestSeq: 2, hasMore: false })
    await Promise.all([first, reconnect, gap])
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(client.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(key)?.pages.flatMap((page) => page.messages.map((message) => message.id))).toEqual(["m_2", "m_3", "m_4", "m_5", "m_1"])
    apiFetchMock.mockResolvedValueOnce({ messages: [], latestSeq: 5, hasMore: false })
    await reconcileFocusedMessageQueries(client, kind, "shared")
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    unsubscribe()
    client.clear()
  })

  it("refreshes a completed query variant when another variant still holds the scope owner", async () => {
    const { client: client } = await createCommunityQueryOwner("a")
    const key = communityKeys.channelMessages("variants")
    const taggedKey = [...key, "tag", "selected"]
    const subscriptions = [seedActiveQuery(client, key), seedActiveQuery(client, taggedKey)]
    let releaseTagged!: (page: unknown) => void
    const tagged = new Promise((resolve) => { releaseTagged = resolve })
    const fresh = { messages: [3, 4, 5].map((seq) => ({ id: `m_${seq}`, seq, createdAt: `2026-08-15T00:00:0${seq}.000Z` })), latestSeq: 5, hasMoreNewer: false }
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes("since=")) return Promise.resolve(fresh)
      if (url.includes("tag=")) return tagged
      return Promise.resolve({ messages: [], latestSeq: apiFetchMock.mock.calls.length > 2 ? 5 : 2, hasMore: false })
    })
    const first = reconcileFocusedMessageQueries(client, "channel", "variants")
    await vi.waitFor(() => expect(publishCommunityMessagesMock).toHaveBeenCalledOnce())
    const gap = scheduleFocusedMessageGapRepair(client, { kind: "channel", scopeId: "variants" }, 5)
    await vi.waitFor(() => expect(publishCommunityMessagesMock).toHaveBeenCalledTimes(2))
    releaseTagged({ messages: [], latestSeq: 2, hasMore: false })
    await Promise.all([first, gap])
    for (const queryKey of [key, taggedKey]) {
      expect(client.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(queryKey)?.pages.flatMap((page) => page.messages.map((message) => message.id))).toEqual(["m_2", "m_3", "m_4", "m_5", "m_1"])
    }
    expect(apiFetchMock.mock.calls.filter(([url]) => String(url).includes("tag=") && !String(url).includes("since="))).toHaveLength(1)
    for (const subscription of subscriptions) subscription.unsubscribe()
    client.clear()
  })

  it.each(["account", "permission", "replacement"] as const)("does not share an old repair after %s changes or let its cleanup remove the new owner", async (change) => {
    const { client: client } = await createCommunityQueryOwner("a")
    getCommunityRuntime(client).ws.actions.activateProfileAccount("a")
    const key = communityKeys.channelMessages("changed")
    const subscriptions = [seedActiveQuery(client, key).unsubscribe]
    let rejectOld!: (reason: unknown) => void
    let releaseNew!: (page: unknown) => void
    apiFetchMock.mockReturnValueOnce(new Promise((_, reject) => { rejectOld = reject }))
    const first = reconcileFocusedMessageQueries(client, "channel", "changed")
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    if (change === "account") getCommunityRuntime(client).ws.actions.activateProfileAccount("b")
    else if (change === "permission") {
      getCommunityRuntime(client).ws.actions.revokeChannelAccess("server", "changed")
      getCommunityRuntime(client).ws.actions.rememberChannelAccess("server", "changed")
    } else {
      client.removeQueries({ queryKey: key, exact: true })
      subscriptions.push(seedActiveQuery(client, key).unsubscribe)
    }
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { releaseNew = resolve }))
    const second = reconcileFocusedMessageQueries(client, "channel", "changed")
    expect(second).not.toBe(first)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    rejectOld(new ApiError("old denial", 403))
    await first
    expect(client.getQueryData(key)).toBeDefined()
    const shared = reconcileFocusedMessageQueries(client, "channel", "changed")
    expect(scheduleFocusedMessageGapRepair(client, { kind: "channel", scopeId: "changed" }, 5)).not.toBeNull()
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    apiFetchMock.mockResolvedValueOnce({ messages: [], latestSeq: 5, hasMoreNewer: false })
    releaseNew({ messages: [{ id: "m_2", content: "current", seq: 2, createdAt: "2026-08-15T00:00:02.000Z" }], latestSeq: 2, hasMore: false })
    await Promise.all([second, shared])
    expect(publishCommunityMessagesMock).toHaveBeenCalledOnce()
    expect(client.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(key)?.pages[0].messages[0].id).toBe("m_2")
    expect(getCommunityDbRegistry(client)?.collections.messages.get("m_2")?.content).toBe("current")
    for (const unsubscribe of subscriptions) unsubscribe()
    client.clear()
  })

  it("does not repair exact-next, duplicate, or out-of-order frames", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_contiguous")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)

    expect(scheduleFocusedMessageGapRepair(
      queryClient,
      { kind: "channel", scopeId: "ch_contiguous", serverId: "s1" },
      3,
    )).toBeNull()
    expect(scheduleFocusedMessageGapRepair(
      queryClient,
      { kind: "channel", scopeId: "ch_contiguous", serverId: "s1" },
      2,
    )).toBeNull()
    expect(scheduleFocusedMessageGapRepair(
      queryClient,
      { kind: "channel", scopeId: "ch_contiguous", serverId: "s1" },
      1,
    )).toBeNull()
    expect(apiFetchMock).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("coalesces simultaneous gap frames onto one focused catch-up", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_gap")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    const setQueryDataSpy = vi.spyOn(queryClient, "setQueryData")
    apiFetchMock
      .mockResolvedValueOnce({
        messages: [{
          id: "m_2",
          type: "chat",
          seq: 2,
          createdAt: "2026-08-15T00:00:02.000Z",
        }],
        latestSeq: 6,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        messages: [3, 4, 5, 6].map((seq) => ({
          id: `m_${seq}`,
          type: "chat",
          seq,
          createdAt: `2026-08-15T00:00:0${seq}.000Z`,
        })),
        latestSeq: 6,
        hasMoreNewer: false,
      })

    const first = scheduleFocusedMessageGapRepair(
      queryClient,
      { kind: "channel", scopeId: "ch_gap", serverId: "s1" },
      5,
    )
    const second = scheduleFocusedMessageGapRepair(
      queryClient,
      { kind: "channel", scopeId: "ch_gap", serverId: "s1" },
      6,
    )
    expect(first).not.toBeNull()
    expect(queryClient.getQueryCache().find({ queryKey: [...queryKey, "reconcile"], exact: true })?.state.fetchStatus).toBe("fetching")
    await first
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(captureCommunityLiveSnapshotTokenMock).toHaveBeenCalledWith(queryClient, "ch_gap")
    expect(publishCommunityMessagesMock).toHaveBeenCalledWith(queryClient, {
      channelId: "ch_gap",
      messages: expect.arrayContaining([
        expect.objectContaining({ id: "m_2" }),
        expect.objectContaining({ id: "m_3" }),
        expect.objectContaining({ id: "m_6" }),
      ]),
      proof: { token: expect.objectContaining({ queryClient }), signal: expect.any(AbortSignal) },
    })
    expect(captureCommunityLiveSnapshotTokenMock.mock.invocationCallOrder[0])
      .toBeLessThan(apiFetchMock.mock.invocationCallOrder[0]!)
    expect(publishCommunityMessagesMock.mock.invocationCallOrder[0])
      .toBeLessThan(setQueryDataSpy.mock.invocationCallOrder[setQueryDataSpy.mock.calls.findIndex(([key]) => JSON.stringify(key) === JSON.stringify(queryKey))]!)
    unsubscribe()
  })

  it("does not mistake a page latestSeq watermark for a locally cached row", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.dmMessages("dm_gap")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    queryClient.setQueryData<any>(queryKey, (current: any) => ({
      ...current,
      pages: current.pages.map((page: any) => ({ ...page, latestSeq: 99 })),
    }))
    apiFetchMock.mockResolvedValue({
      messages: [],
      latestSeq: 2,
      hasMore: false,
    })

    const repair = scheduleFocusedMessageGapRepair(
      queryClient,
      { kind: "dm", scopeId: "dm_gap" },
      5,
    )
    expect(repair).not.toBeNull()
    await repair
    expect(apiFetchMock).toHaveBeenCalled()
    unsubscribe()
  })

  it("keeps the painted message cache visible while reconnect reconciliation is in flight", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_visible")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    let resolveRefresh!: (page: {
      messages: Array<Record<string, unknown>>
      hasMore: boolean
      cursor: string
      latestSeq: number
    }) => void
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = resolve
    }))

    const reconciliation = reconcileFocusedMessageQueries(
      queryClient,
      "channel",
      "ch_visible",
    )
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())

    expect(queryClient.getQueryData<{
      pages: Array<{ messages: Array<{ id: string }> }>
    }>(queryKey)?.pages.flatMap((page) => page.messages.map((message) => message.id))).toEqual([
      "m_2",
      "m_1",
    ])

    resolveRefresh({
      messages: [{
        id: "m_2",
        type: "chat",
        seq: 2,
        createdAt: "2026-08-15T00:00:02.000Z",
      }],
      hasMore: true,
      cursor: "older-2",
      latestSeq: 2,
    })
    await reconciliation
    unsubscribe()
  })

  it("evicts a focused scope only after an authoritative access denial", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_denied")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock.mockRejectedValueOnce(new ApiError("forbidden", 403))

    await reconcileFocusedMessageQueries(queryClient, "channel", "ch_denied")

    expect(queryClient.getQueryData(queryKey)).toBeUndefined()
    unsubscribe()
  })

  it("retains the focused scope on transient reconnect failure", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_offline")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock.mockRejectedValueOnce(new ApiError("unavailable", 503))

    await expect(
      reconcileFocusedMessageQueries(queryClient, "channel", "ch_offline"),
    ).rejects.toThrow("unavailable")

    expect(queryClient.getQueryData(queryKey)).toBeDefined()
    unsubscribe()
  })

  it("cancels and replays an in-flight older-page fetch so neither side overwrites the other", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_race")
    let resolveStaleOlder!: (page: {
      messages: Array<Record<string, unknown>>
      hasMore: boolean
      latestSeq: number
    }) => void
    const staleOlder = new Promise<{
      messages: Array<Record<string, unknown>>
      hasMore: boolean
      latestSeq: number
    }>((resolve) => {
      resolveStaleOlder = resolve
    })
    const olderSignals: AbortSignal[] = []
    let olderCallCount = 0
    const queryFn = vi.fn(async ({
      pageParam,
      signal,
    }: {
      pageParam: { mode: string }
      signal: AbortSignal
    }) => {
      if (pageParam.mode === "newest") {
        return {
          messages: [{
            id: "m_2",
            type: "chat",
            seq: 2,
            createdAt: "2026-08-15T00:00:02.000Z",
          }],
          hasMore: true,
          cursor: "older-2",
          latestSeq: 2,
        }
      }
      olderCallCount += 1
      olderSignals.push(signal)
      if (olderCallCount === 1) return staleOlder
      return {
        messages: [{
          id: "m_1",
          type: "chat",
          seq: 1,
          createdAt: "2026-08-15T00:00:01.000Z",
        }],
        hasMore: false,
        latestSeq: 3,
      }
    })
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey,
      queryFn,
      initialPageParam: { mode: "newest" } as const,
      getNextPageParam: (last) => last.hasMore && last.cursor
        ? { mode: "older" as const, cursor: last.cursor }
        : undefined,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().isSuccess).toBe(true)
    })
    const pendingOlder = observer.fetchNextPage()
    await vi.waitFor(() => {
      expect(olderCallCount).toBe(1)
    })
    apiFetchMock
      .mockResolvedValueOnce({
        messages: [{
          id: "m_2",
          type: "chat",
          seq: 2,
          createdAt: "2026-08-15T00:00:02.000Z",
        }, {
          id: "m_3",
          type: "chat",
          seq: 3,
          createdAt: "2026-08-15T00:00:03.000Z",
        }],
        hasMore: true,
        cursor: "older-2",
        latestSeq: 3,
      })
      .mockResolvedValueOnce({
        messages: [{
          id: "m_3",
          type: "chat",
          seq: 3,
          createdAt: "2026-08-15T00:00:03.000Z",
        }],
        hasMoreNewer: false,
        latestSeq: 3,
      })

    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const foreground = reconcileFocusedMessageQueries(queryClient, "channel", "ch_race")
    const reconnect = reconcileFocusedMessageQueries(queryClient, "channel", "ch_race")
    expect(queryClient.getQueryCache().find({ queryKey: [...queryKey, "reconcile"], exact: true })?.state.fetchStatus).toBe("fetching")
    await Promise.all([foreground, reconnect])
    expect(cancel).toHaveBeenCalledOnce()
    resolveStaleOlder({
      messages: [{ id: "stale_m_1" }],
      hasMore: false,
      latestSeq: 2,
    })
    await pendingOlder

    expect(olderSignals[0]?.aborted).toBe(true)
    expect(olderCallCount).toBe(2)
    expect(queryClient.getQueryData<{
      pages: Array<{ messages: Array<{ id: string }> }>
    }>(queryKey)?.pages.flatMap((page) => page.messages.map((message) => message.id))).toEqual([
      "m_2",
      "m_3",
      "m_1",
    ])
    unsubscribe()
  })

  it("consumes a new gap arriving while the one pagination replay is still pending", async () => {
    const { client: client } = await createCommunityQueryOwner("a")
    const key = communityKeys.channelMessages("late-replay")
    let olderCalls = 0
    const newest = { messages: [{ id: "m_2", seq: 2, createdAt: "2026-08-15T00:00:02.000Z" }], latestSeq: 2, hasMore: true, cursor: "older" }
    const older = { messages: [{ id: "m_1", seq: 1, createdAt: "2026-08-15T00:00:01.000Z" }], latestSeq: 2, hasMore: false }
    let releaseStale!: (value: typeof older) => void
    let releaseReplay!: (value: typeof older) => void
    const observer = new InfiniteQueryObserver(client, {
      queryKey: key,
      queryFn: async ({ pageParam }) => {
        if (pageParam.mode === "newest") return newest
        olderCalls += 1
        return new Promise<typeof newest | typeof older>((resolve) => {
          if (olderCalls === 1) releaseStale = resolve
          else releaseReplay = resolve
        })
      },
      initialPageParam: { mode: "newest" },
      getNextPageParam: (last) => last.hasMore ? { mode: "older" } : undefined,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true))
    const pagination = observer.fetchNextPage()
    await vi.waitFor(() => expect(olderCalls).toBe(1))
    apiFetchMock.mockResolvedValueOnce(newest).mockResolvedValueOnce({ ...newest, latestSeq: 5 }).mockResolvedValueOnce({
      messages: [3, 4, 5].map((seq) => ({ id: `m_${seq}`, seq, createdAt: `2026-08-15T00:00:0${seq}.000Z` })), latestSeq: 5, hasMoreNewer: false,
    })
    const cancel = vi.spyOn(client, "cancelQueries")
    const foreground = reconcileFocusedMessageQueries(client, "channel", "late-replay")
    await vi.waitFor(() => expect(olderCalls).toBe(2))
    const gap = scheduleFocusedMessageGapRepair(client, { kind: "channel", scopeId: "late-replay" }, 5)
    expect(apiFetchMock).toHaveBeenCalledOnce()
    releaseReplay(older)
    releaseStale(older)
    await Promise.all([foreground, gap, pagination])
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    expect(cancel).toHaveBeenCalledOnce()
    expect(olderCalls).toBe(2)
    expect(client.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(key)?.pages.flatMap((entry) => entry.messages.map((row) => row.id))).toEqual(["m_2", "m_3", "m_4", "m_5", "m_1"])
    unsubscribe()
    client.clear()
  })

  it("does not replay completed pagination whose fetch metadata remains idle", async () => {
    const { client: client } = await createCommunityQueryOwner("a")
    const key = communityKeys.channelMessages("idle-pagination")
    let olderCalls = 0
    const newest = { messages: [{ id: "m_2", seq: 2, createdAt: "2026-08-15T00:00:02.000Z" }], latestSeq: 2, hasMore: true, cursor: "older-2" }
    const observer = new InfiniteQueryObserver(client, {
      queryKey: key,
      queryFn: async ({ pageParam }) => {
        if (pageParam.mode === "newest") return newest
        olderCalls += 1
        return { messages: [{ id: "m_1", seq: 1 }], latestSeq: 2, hasMore: true, cursor: "older-1" }
      },
      initialPageParam: { mode: "newest", cursor: "" },
      getNextPageParam: (last) => last.hasMore ? { mode: "older", cursor: last.cursor } : undefined,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true))
    await observer.fetchNextPage()
    expect(client.getQueryState(key)?.fetchStatus).toBe("idle")
    expect(client.getQueryState(key)?.fetchMeta?.fetchMore?.direction).toBe("forward")
    apiFetchMock.mockResolvedValue(newest)
    await reconcileFocusedMessageQueries(client, "channel", "idle-pagination")
    expect(olderCalls).toBe(1)
    unsubscribe()
    client.clear()
  })

  it.each([
    ["channel", communityKeys.channelMessages("ch_empty"), "ch_empty"],
    ["dm", communityKeys.dmMessages("dm_empty"), "dm_empty"],
  ] as const)(
    "refreshes an empty active %s query so its first missed message appears",
    async (kind, queryKey, scopeId) => {
      const { client: queryClient } = await createCommunityQueryOwner("a")
      const { queryFn, unsubscribe } = seedEmptyActiveQuery(queryClient, queryKey)
      apiFetchMock.mockResolvedValue({
        messages: [{
          id: "m_first",
          type: "chat",
          seq: 1,
          createdAt: "2026-08-15T00:00:01.000Z",
        }],
        hasMore: false,
        latestSeq: 1,
      })

      await reconcileFocusedMessageQueries(queryClient, kind, scopeId)

      expect(apiFetchMock).toHaveBeenCalledOnce()
      expect(apiFetchMock).toHaveBeenCalledWith(
        `/api/community/channels/${scopeId}/messages`, expect.objectContaining({ assertActive: expect.any(Function) }),
      )
      expect(queryFn).not.toHaveBeenCalled()
      const messages = queryClient.getQueryData<{
        pages: Array<{ messages: Array<{ id: string }> }>
      }>(queryKey)?.pages[0].messages ?? []
      expect(messages.map((message) => message.id)).toEqual(["m_first"])
      unsubscribe()
    },
  )

  it.each(["channel", "dm"] as const)("rechecks a stale empty %s window when an in-flight foreground repair receives its first gap", async (kind) => {
    const { client: client } = await createCommunityQueryOwner("a")
    const scopeId = "first-gap"
    const key = kind === "channel" ? communityKeys.channelMessages(scopeId) : communityKeys.dmMessages(scopeId)
    const { queryFn, unsubscribe } = seedEmptyActiveQuery(client, key)
    let release!: (page: unknown) => void
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const repair = reconcileFocusedMessageQueries(client, kind, scopeId)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    const gap = scheduleFocusedMessageGapRepair(client, { kind, scopeId }, 2)
    expect(gap).not.toBeNull()
    apiFetchMock.mockResolvedValueOnce({
      messages: [1, 2].map((seq) => ({ id: `m_${seq}`, seq, createdAt: `2026-08-15T00:00:0${seq}.000Z` })),
      latestSeq: 2,
      hasMore: false,
    })
    release({ messages: [], latestSeq: 0, hasMore: false })
    await Promise.all([repair, gap])
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/community/channels/${scopeId}/messages`,
      `/api/community/channels/${scopeId}/messages`,
    ])
    expect(client.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(key)?.pages[0].messages.map((message) => message.id)).toEqual(["m_1", "m_2"])
    expect(queryFn).not.toHaveBeenCalled()
    unsubscribe()
    client.clear()
  })

  it.each(["channel", "dm"] as const)("bounds stale empty %s reads and allows a later recovery", async (kind) => {
    const { client: client } = await createCommunityQueryOwner("a")
    const scopeId = "bounded-empty"
    const key = kind === "channel" ? communityKeys.channelMessages(scopeId) : communityKeys.dmMessages(scopeId)
    const { queryFn, unsubscribe } = seedEmptyActiveQuery(client, key)
    apiFetchMock.mockResolvedValue({ messages: [], latestSeq: 0, hasMore: false })
    await scheduleFocusedMessageGapRepair(client, { kind, scopeId }, 2)
    expect(apiFetchMock).toHaveBeenCalledTimes(8)
    expect(client.getQueryData<{ pages: Array<{ messages: unknown[] }> }>(key)?.pages[0].messages).toEqual([])
    apiFetchMock.mockResolvedValueOnce({ messages: [{ id: "m_later", seq: 1 }], latestSeq: 1, hasMore: false })
    await reconcileFocusedMessageQueries(client, kind, scopeId)
    expect(apiFetchMock).toHaveBeenCalledTimes(9)
    expect(client.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(key)?.pages[0].messages.map((message) => message.id)).toEqual(["m_later"])
    expect(queryFn).not.toHaveBeenCalled()
    unsubscribe()
    client.clear()
  })

  it.each(["permission", "replacement"] as const)("drops an empty-window retry result after %s changes", async (change) => {
    const { client: client } = await createCommunityQueryOwner("a")
    const scopeId = "empty-retry-owner"
    const key = communityKeys.channelMessages(scopeId)
    const subscriptions = [seedEmptyActiveQuery(client, key).unsubscribe]
    let release!: (page: unknown) => void
    apiFetchMock.mockResolvedValueOnce({ messages: [], latestSeq: 0, hasMore: false })
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const gap = scheduleFocusedMessageGapRepair(client, { kind: "channel", scopeId }, 2)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    const publicationsBeforeRetirement = publishCommunityMessagesMock.mock.calls.length
    if (change === "permission") getCommunityRuntime(client).ws.actions.revokeChannelAccess("server", scopeId)
    else {
      client.removeQueries({ queryKey: key, exact: true })
      subscriptions.push(seedActiveQuery(client, key).unsubscribe)
    }
    const current = client.getQueryData(key)
    release({ messages: [{ id: "m_obsolete", seq: 2 }], latestSeq: 2, hasMore: false })
    await gap
    expect(client.getQueryData(key)).toBe(current)
    expect(publishCommunityMessagesMock).toHaveBeenCalledTimes(publicationsBeforeRetirement)
    expect(getCommunityDbRegistry(client)?.collections.messages.has("m_obsolete")).toBe(false)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    for (const unsubscribe of subscriptions) unsubscribe()
    client.clear()
  })

  it("preserves a same-query cold reset until its canonical read completes instead of rebuilding pages from old HTTP", async () => {
    const { client: client } = await createCommunityQueryOwner("a")
    const key = communityKeys.channelMessages("reset-pending")
    const oldPage = { messages: [{ id: "m_old", seq: 2 }], latestSeq: 2, hasMore: false }
    client.setQueryData(key, { pages: [oldPage], pageParams: [{ mode: "newest" }] })
    let releaseCanonical!: (page: typeof oldPage) => void
    const queryFn = vi.fn(() => new Promise<typeof oldPage>((resolve) => { releaseCanonical = resolve }))
    const observer = new InfiniteQueryObserver(client, {
      queryKey: key,
      queryFn,
      initialPageParam: { mode: "newest" } as const,
      getNextPageParam: () => undefined,
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    const query = client.getQueryCache().find({ queryKey: key, exact: true })
    let releaseOld!: (page: typeof oldPage) => void
    apiFetchMock.mockReturnValueOnce(new Promise((resolve) => { releaseOld = resolve }))
    const repair = reconcileFocusedMessageQueries(client, "channel", "reset-pending")
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    const reset = client.resetQueries({ queryKey: key, exact: true })
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledOnce())
    expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBe(query)
    expect(client.getQueryData(key)).toBeUndefined()
    releaseOld(oldPage)
    await repair
    expect(client.getQueryData(key)).toBeUndefined()
    releaseCanonical({ messages: [{ id: "m_current", seq: 3 }], latestSeq: 3, hasMore: false })
    await reset
    expect(client.getQueryData<{ pages: Array<{ messages: Array<{ id: string }> }> }>(key)?.pages[0].messages.map((message) => message.id)).toEqual(["m_current"])
    expect(queryFn).toHaveBeenCalledOnce()
    expect(apiFetchMock).toHaveBeenCalledOnce()
    unsubscribe()
    client.clear()
  })

  it.each([
    ["channel", communityKeys.channelMessages("ch_cold"), "ch_cold"],
    ["dm", communityKeys.dmMessages("dm_cold"), "dm_cold"],
  ] as const)(
    "recovers a cold failed active %s query through its canonical queryFn",
    async (kind, queryKey, scopeId) => {
      const { client: queryClient } = await createCommunityQueryOwner("a")
      const queryFn = vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({
          messages: [{
            id: "m_after_reconnect",
            type: "chat",
            seq: 1,
            createdAt: "2026-08-15T00:00:01.000Z",
          }],
          hasMore: false,
          latestSeq: 1,
        })
      const observer = new InfiniteQueryObserver(queryClient, {
        queryKey,
        queryFn,
        initialPageParam: { mode: "newest" } as const,
        getNextPageParam: () => undefined,
        retry: false,
      })
      const unsubscribe = observer.subscribe(() => undefined)
      await vi.waitFor(() => {
        expect(observer.getCurrentResult().isError).toBe(true)
      })

      await reconcileFocusedMessageQueries(queryClient, kind, scopeId)

      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(apiFetchMock).not.toHaveBeenCalled()
      const data = queryClient.getQueryData<{
        pages: Array<{ messages: Array<{ id: string }> }>
      }>(queryKey)
      expect(data?.pages[0].messages.map((message) => message.id)).toEqual([
        "m_after_reconnect",
      ])
      unsubscribe()
    },
  )

  it("refreshes an anchor window, then catches up only from its newest cached row", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_anchor")
    queryClient.setQueryData(queryKey, {
      pages: [{
        messages: [{
          id: "m_10",
          type: "chat",
          seq: 10,
          createdAt: "2026-08-15T00:00:10.000Z",
        }],
        hasMoreOlder: true,
        olderCursor: "older-10",
        hasMoreNewer: true,
        newerCursor: "newer-10",
        newestCursor: "2026-08-15T00:00:10.000Z|m_10",
        latestSeq: 10,
      }],
      pageParams: [{ mode: "anchor", anchor: "m_10" }],
    })
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: vi.fn(async () => ({ stale: true })),
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    apiFetchMock
      .mockResolvedValueOnce({
        messages: [{
          id: "m_10",
          type: "chat",
          seq: 10,
          createdAt: "2026-08-15T00:00:10.000Z",
        }],
        hasMoreOlder: true,
        olderCursor: "older-10",
        hasMoreNewer: true,
        newerCursor: "newer-10",
        latestSeq: 11,
      })
      .mockResolvedValueOnce({
        messages: [{
          id: "m_11",
          type: "chat",
          seq: 11,
          createdAt: "2026-08-15T00:00:11.000Z",
        }],
        hasMoreNewer: false,
        latestSeq: 11,
      })

    await reconcileFocusedMessageQueries(queryClient, "channel", "ch_anchor")

    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/community/channels/ch_anchor/messages?anchor=m_10",
      "/api/community/channels/ch_anchor/messages?since=2026-08-15T00%3A00%3A10.000Z%7Cm_10",
    ])
    expect(queryClient.getQueryData<{
      pages: Array<{ messages: Array<{ id: string }> }>
      pageParams: unknown[]
    }>(queryKey)).toMatchObject({
      pages: [{ messages: [{ id: "m_10" }, { id: "m_11" }] }],
      pageParams: [{ mode: "anchor", anchor: "m_10" }],
    })
    unsubscribe()
  })

  it("walks only forward delta pages and preserves every cached history page", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_1")
    const { queryFn, unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock
      .mockResolvedValueOnce({
        messages: [{
          id: "m_2",
          type: "chat",
          seq: 2,
          createdAt: "2026-08-15T00:00:02.000Z",
        }],
        hasMore: true,
        cursor: "older-2",
        latestSeq: 4,
      })
      .mockResolvedValueOnce({
        messages: [{
          id: "m_3",
          type: "chat",
          seq: 3,
          createdAt: "2026-08-15T00:00:03.000Z",
        }],
        hasMoreNewer: true,
        newerCursor: "2026-08-15T00:00:03.000Z|m_3",
        latestSeq: 4,
      })
      .mockResolvedValueOnce({
        messages: [{
          id: "m_4",
          type: "chat",
          seq: 4,
          createdAt: "2026-08-15T00:00:04.000Z",
        }],
        hasMoreNewer: false,
        latestSeq: 4,
      })

    await reconcileFocusedMessageQueries(queryClient, "channel", "ch_1")

    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/community/channels/ch_1/messages",
      "/api/community/channels/ch_1/messages?since=2026-08-15T00%3A00%3A02.000Z%7Cm_2",
      "/api/community/channels/ch_1/messages?since=2026-08-15T00%3A00%3A03.000Z%7Cm_3",
    ])
    expect(queryFn).not.toHaveBeenCalled()
    expect(queryClient.getQueryData<{
      pages: Array<{
        messages: Array<{ id: string }>
        latestSeq?: number
        hasMore?: boolean
        cursor?: string
        hasMoreNewer?: boolean
      }>
      pageParams: unknown[]
    }>(queryKey)).toMatchObject({
      pages: [
        {
          messages: [{ id: "m_2" }, { id: "m_3" }, { id: "m_4" }],
          latestSeq: 4,
          hasMore: true,
          cursor: "older-2",
          hasMoreNewer: false,
        },
        { messages: [{ id: "m_1" }] },
      ],
      pageParams: [
        { mode: "newest" },
        { mode: "older", cursor: "older-2" },
      ],
    })
    unsubscribe()
  })

  it("caps forward catch-up at eight pages and leaves the newer cursor resumable", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_bounded")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock.mockResolvedValueOnce({
      messages: [{
        id: "m_2",
        type: "chat",
        seq: 2,
        createdAt: "2026-08-15T00:00:02.000Z",
      }],
      hasMore: true,
      cursor: "older-2",
      latestSeq: 100,
    })
    for (let seq = 3; seq <= 10; seq += 1) {
      apiFetchMock.mockResolvedValueOnce({
        messages: [{
          id: `m_${seq}`,
          type: "chat",
          seq,
          createdAt: `2026-08-15T00:00:${String(seq).padStart(2, "0")}.000Z`,
        }],
        hasMoreNewer: true,
        newerCursor: `2026-08-15T00:00:${String(seq).padStart(2, "0")}.000Z|m_${seq}`,
        latestSeq: 100,
      })
    }

    await reconcileFocusedMessageQueries(queryClient, "channel", "ch_bounded")

    expect(apiFetchMock).toHaveBeenCalledTimes(9)
    expect(apiFetchMock.mock.calls.at(-1)?.[0]).toBe(
      "/api/community/channels/ch_bounded/messages?since=2026-08-15T00%3A00%3A09.000Z%7Cm_9",
    )
    expect(queryClient.getQueryData<{
      pages: Array<{
        messages: Array<{ id: string }>
        hasMoreNewer?: boolean
        newerCursor?: string
      }>
    }>(queryKey)?.pages[0]).toMatchObject({
      messages: Array.from({ length: 9 }, (_, index) => ({ id: `m_${index + 2}` })),
      hasMoreNewer: true,
      newerCursor: "2026-08-15T00:00:10.000Z|m_10",
    })
    unsubscribe()
  })

  it("refreshes one visible window for missed edits without walking history", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_1")
    const { queryFn, unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock.mockResolvedValue({
      messages: [{
        id: "m_2",
        type: "chat",
        seq: 2,
        content: "edited while disconnected",
        createdAt: "2026-08-15T00:00:02.000Z",
      }],
      hasMore: true,
      cursor: "older-2",
      latestSeq: 2,
    })

    await reconcileFocusedMessageQueries(queryClient, "channel", "ch_1")

    expect(apiFetchMock).toHaveBeenCalledOnce()
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/ch_1/messages", expect.objectContaining({ assertActive: expect.any(Function) }),
    )
    expect(queryFn).not.toHaveBeenCalled()
    expect(queryClient.getQueryData<{
      pages: Array<{ messages: Array<{ id: string; content?: string }> }>
    }>(queryKey)?.pages[0].messages[0]).toMatchObject({
      id: "m_2",
    })
    expect(getCommunityDbRegistry(queryClient)?.collections.messages.get("m_2")?.content).toBe("edited while disconnected")
    unsubscribe()
  })

  it("merges into the latest cache so a live WS row arriving mid-reconcile is preserved", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.channelMessages("ch_1")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock.mockImplementationOnce(async () => {
      queryClient.setQueryData(queryKey, (current: {
        pages: Array<{ messages: Array<Record<string, unknown>> }>
        pageParams: unknown[]
      } | undefined) => current
        ? {
            ...current,
            pages: [{
              ...current.pages[0],
              messages: [...current.pages[0].messages, {
                id: "m_live",
                type: "chat",
                seq: 3,
                createdAt: "2026-08-15T00:00:03.000Z",
              }],
            }, ...current.pages.slice(1)],
          }
        : current)
      return {
        messages: [{
          id: "m_2",
          type: "chat",
          seq: 2,
          content: "refreshed",
          createdAt: "2026-08-15T00:00:02.000Z",
        }],
        hasMore: true,
        cursor: "older-2",
        latestSeq: 2,
      }
    })

    await reconcileFocusedMessageQueries(queryClient, "channel", "ch_1")

    expect(queryClient.getQueryData<{
      pages: Array<{ messages: Array<{ id: string; content?: string }> }>
    }>(queryKey)?.pages[0].messages).toMatchObject([
      { id: "m_2" },
      { id: "m_live" },
    ])
    expect(getCommunityDbRegistry(queryClient)?.collections.messages.get("m_2")?.content).toBe("refreshed")
    unsubscribe()
  })

  it("keeps a DM's loaded history pages while refreshing its current window", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.dmMessages("dm_1")
    const { queryFn, unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock.mockResolvedValue({
      messages: [{
        id: "m_2",
        type: "chat",
        seq: 2,
        createdAt: "2026-08-15T00:00:02.000Z",
      }],
      hasMore: true,
      cursor: "older-2",
      latestSeq: 2,
    })

    await reconcileFocusedMessageQueries(queryClient, "dm", "dm_1")

    expect(apiFetchMock).toHaveBeenCalledOnce()
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/dm_1/messages", expect.objectContaining({ assertActive: expect.any(Function) }),
    )
    expect(queryFn).not.toHaveBeenCalled()
    expect(queryClient.getQueryData<{
      pages: Array<{ messages: Array<{ id: string }> }>
      pageParams: unknown[]
    }>(queryKey)).toMatchObject({
      pages: [
        { messages: [{ id: "m_2" }] },
        { messages: [{ id: "m_1" }] },
      ],
      pageParams: [
        { mode: "newest" },
        { mode: "older", cursor: "older-2" },
      ],
    })
    unsubscribe()
  })

  it("keeps a tag-filtered active query scoped to the same tag", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = [...communityKeys.channelMessages("forum_1"), "tag", "bug"] as const
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock.mockResolvedValue({ messages: [], hasMoreNewer: false, latestSeq: 2 })

    await reconcileFocusedMessageQueries(queryClient, "channel", "forum_1")

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/forum_1/messages?tag=bug", expect.objectContaining({ assertActive: expect.any(Function) }),
    )
    unsubscribe()
  })

  it("leaves rendered cache untouched when catch-up fails", async () => {
    const { client: queryClient } = await createCommunityQueryOwner("a")
    const queryKey = communityKeys.dmMessages("dm_1")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    const before = queryClient.getQueryData(queryKey)
    apiFetchMock.mockRejectedValue(new Error("network unavailable"))

    await expect(
      reconcileFocusedMessageQueries(queryClient, "dm", "dm_1"),
    ).rejects.toThrow("network unavailable")

    expect(queryClient.getQueryData(queryKey)).toBe(before)
    unsubscribe()
  })
})
