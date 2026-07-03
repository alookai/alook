import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useInboxForYou / inboxForYouQueryFn", () => {
  it("fetches /inbox/foryou and populates queryClient at communityKeys.inboxForYou()", async () => {
    apiFetchMock.mockResolvedValueOnce({ events: [] })
    const { inboxForYouQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const key = communityKeys.inboxForYou()
    await qc.fetchQuery({ queryKey: key, queryFn: inboxForYouQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/inbox/foryou")
    expect(qc.getQueryData(key)).toEqual({ events: [] })
  })
})

describe("useInboxUnreads / inboxUnreadsQueryFn", () => {
  it("fetches /inbox/unreads and populates queryClient at communityKeys.inboxUnreads()", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [] })
    const { inboxUnreadsQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const key = communityKeys.inboxUnreads()
    await qc.fetchQuery({ queryKey: key, queryFn: inboxUnreadsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/inbox/unreads")
    expect(qc.getQueryData(key)).toEqual({ servers: [] })
  })
})

describe("useInboxMentions / inboxMentionsQueryFn", () => {
  it("fetches /inbox/mentions and populates queryClient at communityKeys.inboxMentions()", async () => {
    apiFetchMock.mockResolvedValueOnce({ mentions: [] })
    const { inboxMentionsQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const key = communityKeys.inboxMentions()
    await qc.fetchQuery({ queryKey: key, queryFn: inboxMentionsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/inbox/mentions")
    expect(qc.getQueryData(key)).toEqual({ mentions: [] })
  })
})

// The plan pins this invariant: `invalidateQueries({ queryKey: inbox() })`
// must refresh all three feeds. Step 3's WS reconciliation depends on this
// working, so we test it here — losing this behaviour would silently regress
// mention/unread refreshing.
describe("communityKeys.inbox() prefix invalidation", () => {
  it("invalidates all three inbox queries in a single call", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ events: [] })
      .mockResolvedValueOnce({ servers: [] })
      .mockResolvedValueOnce({ mentions: [] })
    const { inboxForYouQueryFn, inboxUnreadsQueryFn, inboxMentionsQueryFn } = await import(
      "./use-inbox"
    )
    const qc = new QueryClient()
    const forYouKey = communityKeys.inboxForYou()
    const unreadsKey = communityKeys.inboxUnreads()
    const mentionsKey = communityKeys.inboxMentions()
    await qc.fetchQuery({ queryKey: forYouKey, queryFn: inboxForYouQueryFn })
    await qc.fetchQuery({ queryKey: unreadsKey, queryFn: inboxUnreadsQueryFn })
    await qc.fetchQuery({ queryKey: mentionsKey, queryFn: inboxMentionsQueryFn })

    await qc.invalidateQueries({ queryKey: communityKeys.inbox() })

    expect(qc.getQueryState(forYouKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(unreadsKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(mentionsKey)?.isInvalidated).toBe(true)
  })
})
