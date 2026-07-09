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

describe("useInboxUnreads / inboxUnreadsQueryFn", () => {
  it("fetches /inbox/unreads and populates queryClient at communityKeys.inboxUnreads()", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [], dms: [] })
    const { inboxUnreadsQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const key = communityKeys.inboxUnreads()
    await qc.fetchQuery({ queryKey: key, queryFn: inboxUnreadsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/inbox/unreads")
    expect(qc.getQueryData(key)).toEqual({ servers: [], dms: [] })
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

// WS reconciliation invalidates the shared `inbox()` prefix — both feeds must
// pick it up, otherwise mentions or unread refreshes would silently drop.
describe("communityKeys.inbox() prefix invalidation", () => {
  it("invalidates both inbox queries in a single call", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ servers: [], dms: [] })
      .mockResolvedValueOnce({ mentions: [] })
    const { inboxUnreadsQueryFn, inboxMentionsQueryFn } = await import(
      "./use-inbox"
    )
    const qc = new QueryClient()
    const unreadsKey = communityKeys.inboxUnreads()
    const mentionsKey = communityKeys.inboxMentions()
    await qc.fetchQuery({ queryKey: unreadsKey, queryFn: inboxUnreadsQueryFn })
    await qc.fetchQuery({ queryKey: mentionsKey, queryFn: inboxMentionsQueryFn })

    await qc.invalidateQueries({ queryKey: communityKeys.inbox() })

    expect(qc.getQueryState(unreadsKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(mentionsKey)?.isInvalidated).toBe(true)
  })
})
