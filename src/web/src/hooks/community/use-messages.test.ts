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

describe("channelMessagesQueryFn", () => {
  it("appends ?cursor when a pageParam is provided", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false })
    const fn = channelMessagesQueryFn("ch_1")
    await fn({ pageParam: null })
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/community/channels/ch_1/messages")

    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false })
    await fn({ pageParam: "2026-07-03T00:00:00.000Z|abc" })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/ch_1/messages?cursor=2026-07-03T00%3A00%3A00.000Z%7Cabc",
    )
  })

  it("populates queryClient at communityKeys.channelMessages(channelId)", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [{ id: "m_1" }], hasMore: false })
    const qc = new QueryClient()
    const key = communityKeys.channelMessages("ch_1")
    await qc.fetchInfiniteQuery({
      queryKey: key,
      queryFn: channelMessagesQueryFn("ch_1"),
      initialPageParam: null as string | null,
    })
    expect(qc.getQueryData(key)).toBeDefined()
  })

  // ── Prefix-invalidation integration guard ─────────────────────────────────
  // Foundation invariant: invalidating `channelMessages(channelId)` marks
  // every `channelMessagesPage(channelId, …)` variant as invalidated too.
  // If a future change breaks the key-nesting contract, this test fails and
  // the invariant is defended before it can silently regress in production.
  it("prefix invalidation via channelMessages(id) marks channelMessagesPage(id, cursor) invalidated", async () => {
    const { channelMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false })
    const qc = new QueryClient()
    const cursorKey = communityKeys.channelMessagesPage("ch_1", "cur|abc")
    await qc.fetchQuery({ queryKey: cursorKey, queryFn: channelMessagesQueryFn("ch_1") })
    expect(qc.getQueryData(cursorKey)).toBeDefined()

    await qc.invalidateQueries({ queryKey: communityKeys.channelMessages("ch_1") })
    expect(qc.getQueryState(cursorKey)?.isInvalidated).toBe(true)
  })
})

describe("dmMessagesQueryFn", () => {
  it("appends ?cursor when a pageParam is provided", async () => {
    const { dmMessagesQueryFn } = await loadHook()
    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false })
    await dmMessagesQueryFn("dm_1")({ pageParam: null })
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/community/dm/dm_1/messages")

    apiFetchMock.mockResolvedValueOnce({ messages: [], hasMore: false })
    await dmMessagesQueryFn("dm_1")({ pageParam: "cur_1" })
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/dm/dm_1/messages?cursor=cur_1",
    )
  })

  it("fetchNextPage produces a new page under the same infinite key", async () => {
    const { dmMessagesQueryFn } = await loadHook()
    apiFetchMock
      .mockResolvedValueOnce({ messages: [{ id: "m_1" }], hasMore: true, cursor: "cur_1" })
      .mockResolvedValueOnce({ messages: [{ id: "m_2" }], hasMore: false })
    const qc = new QueryClient()
    const key = communityKeys.dmMessages("dm_1")
    await qc.fetchInfiniteQuery({
      queryKey: key,
      queryFn: dmMessagesQueryFn("dm_1"),
      initialPageParam: null as string | null,
      getNextPageParam: (last: { hasMore: boolean; cursor?: string }) =>
        last.hasMore ? (last.cursor ?? null) : undefined,
      pages: 2,
    })
    const data = qc.getQueryData<InfiniteData<{ messages: unknown[] }>>(key)
    expect(data?.pages).toHaveLength(2)
  })
})
