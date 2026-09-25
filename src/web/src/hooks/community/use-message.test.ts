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

describe("useMessage / messageQueryFn", () => {
  it("fetches from /messages/:id and returns the hydrated payload", async () => {
    const payload = {
      id: "m_1",
      authorId: "u_1",
      authorName: "Alice",
      authorAvatar: "",
      content: "hi there",
      createdAt: "2026-07-03T00:00:00.000Z",
    }
    apiFetchMock.mockResolvedValueOnce(payload)
    const { messageQueryFn } = await import("./use-message")
    const data = await messageQueryFn("m_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/messages/m_1")
    expect(data).toEqual(payload)
  })

  it("populates queryClient at communityKeys.message(messageId)", async () => {
    apiFetchMock.mockResolvedValueOnce({
      id: "m_1",
      authorId: "u_1",
      authorName: "Alice",
      authorAvatar: "",
      content: "hi",
      createdAt: "2026-07-03T00:00:00.000Z",
    })
    const { messageQueryFn } = await import("./use-message")
    const qc = new QueryClient()
    const key = communityKeys.message("m_1")
    await qc.fetchQuery({ queryKey: key, queryFn: messageQueryFn("m_1") })
    expect(qc.getQueryData(key)).toBeDefined()
  })

  it("derives an opener placeholder from a persisted message window", async () => {
    const qc = new QueryClient()
    qc.setQueryData(communityKeys.members("server-1"), {
      pages: [{ members: [{ id: "u_1" }] }],
      pageParams: [null],
    })
    qc.setQueryData(communityKeys.channelMessages("channel-1"), {
      pages: [{
        messages: [{
          id: "m_1",
          type: "chat",
          authorId: "u_1",
          authorName: "Alice",
          content: "cached opener",
          createdAt: "2026-07-03T00:00:00.000Z",
          replyTo: { id: "m_0", authorName: "Bob", text: "parent" },
          attachments: [{ kind: "file", name: "notes.txt", url: "/notes.txt", size: "1 KB" }],
          embeds: [{ title: "Reference" }],
          reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["u_1"] }],
        }],
        hasMoreOlder: false,
        hasMoreNewer: false,
      }],
      pageParams: [{ mode: "newest" }],
    })
    const { findCachedMessage } = await import("./use-message")

    expect(findCachedMessage(qc, "m_1")).toMatchObject({
      id: "m_1",
      authorId: "u_1",
      authorName: "Alice",
      content: "cached opener",
      replyTo: { id: "m_0", authorName: "Bob", text: "parent" },
      attachments: [{ kind: "file", name: "notes.txt", url: "/notes.txt", size: "1 KB" }],
      embeds: [{ title: "Reference" }],
      reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["u_1"] }],
    })
    expect(findCachedMessage(qc, "missing")).toBeUndefined()
  })

  // ── Invalidation contract guard ──────────────────────────────────────────
  // The whole point of moving ThreadOpener onto useQuery: an edit/reaction on
  // the parent message can invalidate `communityKeys.message(id)` and the
  // opener refetches. If the key nesting ever drifts (e.g. someone re-scopes
  // it under a channel), this guard catches it before the "live opener"
  // contract silently breaks.
  it("invalidating communityKeys.message(id) marks the cached entry invalidated", async () => {
    apiFetchMock.mockResolvedValueOnce({
      id: "m_1",
      authorId: "u_1",
      authorName: "Alice",
      authorAvatar: "",
      content: "hi",
      createdAt: "2026-07-03T00:00:00.000Z",
    })
    const { messageQueryFn } = await import("./use-message")
    const qc = new QueryClient()
    const key = communityKeys.message("m_1")
    await qc.fetchQuery({ queryKey: key, queryFn: messageQueryFn("m_1") })
    await qc.invalidateQueries({ queryKey: communityKeys.message("m_1") })
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("prefix invalidation via communityKeys.all also marks message(id) invalidated", async () => {
    apiFetchMock.mockResolvedValueOnce({
      id: "m_1",
      authorId: "u_1",
      authorName: "Alice",
      authorAvatar: "",
      content: "hi",
      createdAt: "2026-07-03T00:00:00.000Z",
    })
    const { messageQueryFn } = await import("./use-message")
    const qc = new QueryClient()
    const key = communityKeys.message("m_1")
    await qc.fetchQuery({ queryKey: key, queryFn: messageQueryFn("m_1") })
    await qc.invalidateQueries({ queryKey: communityKeys.all })
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
  })
})
