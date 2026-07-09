import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient, type InfiniteData } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

// Load *after* the mock is set up so the queryFn resolves the mocked import.
async function loadHook() {
  return await import("./use-messages")
}

// The queryFn dispatches on `pageParam.mode` — one URL per mode. Legacy
// pre-A2 tests passed a raw cursor string; the new signature takes a
// discriminated pageParam so the type-narrowing per branch is explicit.

describe("channelMessagesQueryFn — url per mode", () => {
  it("newest → no query params", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })
    await channelMessagesQueryFn("ch_1")({ pageParam: { mode: "newest" } })
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/community/channels/ch_1/messages")
  })

  it("older → ?cursor=<c>", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })
    await channelMessagesQueryFn("ch_1")({
      pageParam: { mode: "older", cursor: "2026-07-03T00:00:00.000Z|abc" },
    })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/ch_1/messages?cursor=2026-07-03T00%3A00%3A00.000Z%7Cabc",
    )
  })

  it("newer → ?since=<c>", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMoreNewer: false, latestSeq: 0 })
    await channelMessagesQueryFn("ch_1")({
      pageParam: { mode: "newer", cursor: "cur_new" },
    })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/ch_1/messages?since=cur_new",
    )
  })

  it("anchor → ?anchor=<id>", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMoreOlder: false, hasMoreNewer: false, latestSeq: 0 })
    await channelMessagesQueryFn("ch_1")({
      pageParam: { mode: "anchor", anchor: "m_42" },
    })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/ch_1/messages?anchor=m_42",
    )
  })

  it("since → ?since=<c>", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMoreNewer: false, latestSeq: 0 })
    await channelMessagesQueryFn("ch_1")({
      pageParam: { mode: "since", since: "cur_since" },
    })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/ch_1/messages?since=cur_since",
    )
  })
})

describe("channelMessagesQueryFn — queryClient integration", () => {
  it("populates queryClient at communityKeys.channelMessages(channelId)", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [{ id: "m_1" }], hasMore: false })
    const qc = new QueryClient()
    const key = communityKeys.channelMessages("ch_1")
    await qc.fetchInfiniteQuery({
      queryKey: key,
      queryFn: channelMessagesQueryFn("ch_1"),
      initialPageParam: { mode: "newest" } as const,
    })
    expect(qc.getQueryData(key)).toBeDefined()
  })

  // Foundation invariant: invalidating `channelMessages(channelId)` marks
  // every `channelMessagesPage(channelId, …)` variant as invalidated too.
  it("prefix invalidation via channelMessages(id) marks channelMessagesPage(id, cursor) invalidated", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false })
    const qc = new QueryClient()
    const cursorKey = communityKeys.channelMessagesPage("ch_1", "cur|abc")
    await qc.fetchQuery({ queryKey: cursorKey, queryFn: () => apiFetchMock() })
    expect(qc.getQueryData(cursorKey)).toBeDefined()

    await qc.invalidateQueries({ queryKey: communityKeys.channelMessages("ch_1") })
    expect(qc.getQueryState(cursorKey)?.isInvalidated).toBe(true)
  })
})

describe("dmMessagesQueryFn", () => {
  it("newest → no query params", async () => {
    const { dmMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })
    await dmMessagesQueryFn("dm_1")({ pageParam: { mode: "newest" } })
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/community/dm/dm_1/messages")
  })

  it("older cursor → ?cursor", async () => {
    const { dmMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false, latestSeq: 0 })
    await dmMessagesQueryFn("dm_1")({
      pageParam: { mode: "older", cursor: "cur_1" },
    })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/dm/dm_1/messages?cursor=cur_1",
    )
  })

  it("fetchNextPage (older) produces a new page under the same infinite key", async () => {
    const { dmMessagesQueryFn } = await loadHook()
    apiFetchMock
      .mockResolvedValueOnce({ messages: [{ id: "m_1" }], hasMore: true, cursor: "cur_1", latestSeq: 1 })
      .mockResolvedValueOnce({ messages: [{ id: "m_2" }], hasMore: false, latestSeq: 1 })
    const qc = new QueryClient()
    const key = communityKeys.dmMessages("dm_1")
    await qc.fetchInfiniteQuery({
      queryKey: key,
      queryFn: dmMessagesQueryFn("dm_1"),
      initialPageParam: { mode: "newest" } as const,
      getNextPageParam: (last: { hasMore?: boolean; cursor?: string }) =>
        last.hasMore && last.cursor ? { mode: "older" as const, cursor: last.cursor } : undefined,
      pages: 2,
    })
    const data = qc.getQueryData<InfiniteData<{ messages: unknown[] }>>(key)
    expect(data?.pages).toHaveLength(2)
  })
})

// ── mergeMessagesPages reducer ──────────────────────────────────────────
//
// Pages may arrive out of order — anchor first, then interleaved
// older/newer fetches. The reducer sorts across ALL pages by
// (createdAt, id) and dedupes by id so the visible message list is
// always in chronological ASC regardless of fetch sequence.

describe("mergeMessagesPages", () => {
  it("sorts across pages by (createdAt, id) ASC", async () => {
    const { mergeMessagesPages } = await loadHook()
    const pages = [
      {
        messages: [
          { id: "m_3", createdAt: "2026-07-01T00:00:03.000Z" },
          { id: "m_4", createdAt: "2026-07-01T00:00:04.000Z" },
        ],
        hasMoreOlder: false,
        hasMoreNewer: false,
      },
      {
        messages: [
          { id: "m_1", createdAt: "2026-07-01T00:00:01.000Z" },
          { id: "m_2", createdAt: "2026-07-01T00:00:02.000Z" },
        ],
        hasMore: false,
      },
    ]
    const merged = mergeMessagesPages(pages)
    expect(merged.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3", "m_4"])
  })

  it("dedupes by id (keeps first occurrence in sorted order)", async () => {
    const { mergeMessagesPages } = await loadHook()
    const pages = [
      {
        messages: [
          { id: "m_1", createdAt: "2026-07-01T00:00:01.000Z" },
          { id: "m_2", createdAt: "2026-07-01T00:00:02.000Z" },
        ],
      },
      {
        messages: [
          { id: "m_2", createdAt: "2026-07-01T00:00:02.000Z" },
          { id: "m_3", createdAt: "2026-07-01T00:00:03.000Z" },
        ],
      },
    ]
    const merged = mergeMessagesPages(pages)
    expect(merged.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3"])
  })

  it("stable sort — equal createdAt tiebreaks on id", async () => {
    const { mergeMessagesPages } = await loadHook()
    const pages = [
      {
        messages: [
          { id: "m_b", createdAt: "2026-07-01T00:00:01.000Z" },
          { id: "m_a", createdAt: "2026-07-01T00:00:01.000Z" },
        ],
      },
    ]
    const merged = mergeMessagesPages(pages)
    expect(merged.map((m) => m.id)).toEqual(["m_a", "m_b"])
  })

  it("handles empty pages array", async () => {
    const { mergeMessagesPages } = await loadHook()
    expect(mergeMessagesPages([])).toEqual([])
  })
})
