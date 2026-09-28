import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
const {
  liveSnapshotToken,
  captureCommunityLiveSnapshotTokenMock,
  publishCommunityEmbeddedMessagesWithReceiptMock,
} = vi.hoisted(() => {
  const token = { canonicalRevision: 0 }
  return {
    liveSnapshotToken: token,
    captureCommunityLiveSnapshotTokenMock: vi.fn(() => token),
    publishCommunityEmbeddedMessagesWithReceiptMock: vi.fn(() => ({
      status: "published",
      committed: Promise.resolve(),
    })),
  }
})
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock("@/lib/community-db/sync", () => ({
  captureCommunityLiveSnapshotToken: (...args: unknown[]) => (
    captureCommunityLiveSnapshotTokenMock(...args)
  ),
  publishCommunityEmbeddedMessagesWithReceipt: (...args: unknown[]) => (
    publishCommunityEmbeddedMessagesWithReceiptMock(...args)
  ),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
  captureCommunityLiveSnapshotTokenMock.mockClear()
  publishCommunityEmbeddedMessagesWithReceiptMock.mockClear()
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

  it("publishes a sparse exact opener as a partial patch through its response channel", async () => {
    const payload = {
      id: "m_1",
      channelId: "archived-post-1",
      type: "chat" as const,
      authorId: "u_1",
      authorName: "Alice",
      authorAvatar: "",
      authorAvatarVersion: 0,
      content: "archived opener",
      createdAt: "2026-07-03T00:00:00.000Z",
    }
    apiFetchMock.mockResolvedValueOnce(payload)
    const { messageQueryFn } = await import("./use-message")
    const queryClient = new QueryClient()

    await messageQueryFn("m_1", queryClient)()

    expect(publishCommunityEmbeddedMessagesWithReceiptMock).toHaveBeenCalledWith(queryClient, {
      entries: [{ channelId: "archived-post-1", message: payload }],
      proof: { token: liveSnapshotToken, signal: undefined },
    })
  })

  it("does not settle an exact opener before its canonical commit", async () => {
    let resolveCommit!: () => void
    const committed = new Promise<void>((resolve) => { resolveCommit = resolve })
    publishCommunityEmbeddedMessagesWithReceiptMock.mockReturnValueOnce({
      status: "published",
      committed,
    })
    apiFetchMock.mockResolvedValueOnce({
      id: "m_1",
      channelId: "channel-1",
      type: "chat",
      authorId: "u_1",
      authorName: "Alice",
      authorAvatar: "",
      authorAvatarVersion: 0,
      content: "pending commit",
      createdAt: "2026-07-03T00:00:00.000Z",
    })
    const { messageQueryFn } = await import("./use-message")
    let settled = false
    const result = messageQueryFn("m_1", new QueryClient())().then((value) => {
      settled = true
      return value
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    resolveCommit()
    await expect(result).resolves.toMatchObject({ id: "m_1" })
  })

  it("rejects a successful response whose id does not match the request", async () => {
    apiFetchMock.mockResolvedValueOnce({
      id: "wrong",
      channelId: "channel-1",
      type: "chat",
      authorId: "u_1",
      authorName: "Alice",
      authorAvatar: "",
      authorAvatarVersion: 0,
      content: "wrong row",
      createdAt: "2026-07-03T00:00:00.000Z",
    })
    const { messageQueryFn } = await import("./use-message")

    await expect(messageQueryFn("m_1", new QueryClient())()).rejects.toMatchObject({
      name: "CommunityMessageProtocolError",
    })
    expect(publishCommunityEmbeddedMessagesWithReceiptMock).not.toHaveBeenCalled()
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
