import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { reconcileFocusedMessageQueries } from "./reconnect-messages"

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

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("focused message reconnect catch-up", () => {
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
