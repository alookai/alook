import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { ApiError } from "@/lib/errors"
import {
  reconcileFocusedMessageQueries,
  scheduleFocusedMessageGapRepair,
} from "./reconnect-messages"

const apiFetchMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function seedActiveQuery(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
) {
  queryClient.setQueryData(queryKey, {
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
  })
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
})

describe("focused message reconnect catch-up", () => {
  it("does not repair exact-next, duplicate, or out-of-order frames", () => {
    const queryClient = new QueryClient()
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
    const queryClient = new QueryClient()
    const queryKey = communityKeys.channelMessages("ch_gap")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
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
    expect(second).toBe(first)
    await first
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it("does not mistake a page latestSeq watermark for a locally cached row", async () => {
    const queryClient = new QueryClient()
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
    const queryClient = new QueryClient()
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
    const queryClient = new QueryClient()
    const queryKey = communityKeys.channelMessages("ch_denied")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock.mockRejectedValueOnce(new ApiError("forbidden", 403))

    await reconcileFocusedMessageQueries(queryClient, "channel", "ch_denied")

    expect(queryClient.getQueryData(queryKey)).toBeUndefined()
    unsubscribe()
  })

  it("retains the focused scope on transient reconnect failure", async () => {
    const queryClient = new QueryClient()
    const queryKey = communityKeys.channelMessages("ch_offline")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock.mockRejectedValueOnce(new ApiError("unavailable", 503))

    await expect(
      reconcileFocusedMessageQueries(queryClient, "channel", "ch_offline"),
    ).rejects.toThrow("focused messages failed")

    expect(queryClient.getQueryData(queryKey)).toBeDefined()
    unsubscribe()
  })

  it("cancels and replays an in-flight older-page fetch so neither side overwrites the other", async () => {
    const queryClient = new QueryClient()
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

    await reconcileFocusedMessageQueries(queryClient, "channel", "ch_race")
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

  it.each([
    ["channel", communityKeys.channelMessages("ch_empty"), "ch_empty"],
    ["dm", communityKeys.dmMessages("dm_empty"), "dm_empty"],
  ] as const)(
    "refreshes an empty active %s query so its first missed message appears",
    async (kind, queryKey, scopeId) => {
      const queryClient = new QueryClient()
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
        `/api/community/channels/${scopeId}/messages`,
      )
      expect(queryFn).not.toHaveBeenCalled()
      const messages = queryClient.getQueryData<{
        pages: Array<{ messages: Array<{ id: string }> }>
      }>(queryKey)?.pages[0].messages ?? []
      expect(messages.map((message) => message.id)).toEqual(["m_first"])
      unsubscribe()
    },
  )

  it.each([
    ["channel", communityKeys.channelMessages("ch_cold"), "ch_cold"],
    ["dm", communityKeys.dmMessages("dm_cold"), "dm_cold"],
  ] as const)(
    "recovers a cold failed active %s query through its canonical queryFn",
    async (kind, queryKey, scopeId) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
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
    const queryClient = new QueryClient()
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
    const queryClient = new QueryClient()
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
    const queryClient = new QueryClient()
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
    const queryClient = new QueryClient()
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
      "/api/community/channels/ch_1/messages",
    )
    expect(queryFn).not.toHaveBeenCalled()
    expect(queryClient.getQueryData<{
      pages: Array<{ messages: Array<{ id: string; content?: string }> }>
    }>(queryKey)?.pages[0].messages[0]).toMatchObject({
      id: "m_2",
      content: "edited while disconnected",
    })
    unsubscribe()
  })

  it("merges into the latest cache so a live WS row arriving mid-reconcile is preserved", async () => {
    const queryClient = new QueryClient()
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
      { id: "m_2", content: "refreshed" },
      { id: "m_live" },
    ])
    unsubscribe()
  })

  it("keeps a DM's loaded history pages while refreshing its current window", async () => {
    const queryClient = new QueryClient()
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
      "/api/community/channels/dm_1/messages",
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
    const queryClient = new QueryClient()
    const queryKey = [...communityKeys.channelMessages("forum_1"), "tag", "bug"] as const
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    apiFetchMock.mockResolvedValue({ messages: [], hasMoreNewer: false, latestSeq: 2 })

    await reconcileFocusedMessageQueries(queryClient, "channel", "forum_1")

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/forum_1/messages?tag=bug",
    )
    unsubscribe()
  })

  it("leaves rendered cache untouched when catch-up fails", async () => {
    const queryClient = new QueryClient()
    const queryKey = communityKeys.dmMessages("dm_1")
    const { unsubscribe } = seedActiveQuery(queryClient, queryKey)
    const before = queryClient.getQueryData(queryKey)
    apiFetchMock.mockRejectedValue(new Error("network unavailable"))

    await expect(
      reconcileFocusedMessageQueries(queryClient, "dm", "dm_1"),
    ).rejects.toThrow("focused messages failed")

    expect(queryClient.getQueryData(queryKey)).toBe(before)
    unsubscribe()
  })
})
