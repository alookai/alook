import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
const {
  liveSnapshotToken,
  captureCommunityLiveSnapshotTokenMock,
  reconcileCanonicalEmbeddedMessagesMock,
} = vi.hoisted(() => {
  const token = { canonicalRevision: 0 }
  return {
    liveSnapshotToken: token,
    captureCommunityLiveSnapshotTokenMock: vi.fn(() => token),
    reconcileCanonicalEmbeddedMessagesMock: vi.fn(() => Promise.resolve({ status: "published" })),
  }
})
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock("@/lib/community-db/sync", () => ({
  captureCommunityLiveSnapshotToken: (...args: unknown[]) => (
    captureCommunityLiveSnapshotTokenMock(...args)
  ),
  reconcileCanonicalEmbeddedMessages: (...args: unknown[]) => (
    reconcileCanonicalEmbeddedMessagesMock(...args)
  ),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
  captureCommunityLiveSnapshotTokenMock.mockClear()
  reconcileCanonicalEmbeddedMessagesMock.mockClear()
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

    expect(reconcileCanonicalEmbeddedMessagesMock).toHaveBeenCalledWith(queryClient, {
      entries: [{ channelId: "archived-post-1", message: payload }],
      proof: { token: liveSnapshotToken, signal: undefined },
    })
  })

  it("does not settle an exact opener before its canonical commit", async () => {
    let resolveCommit!: () => void
    const committed = new Promise<void>((resolve) => { resolveCommit = resolve })
    reconcileCanonicalEmbeddedMessagesMock.mockReturnValueOnce(committed)
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
    expect(reconcileCanonicalEmbeddedMessagesMock).not.toHaveBeenCalled()
  })

  it("derives an opener placeholder from a persisted message window", async () => {
    const qc = new QueryClient()
    const cached = {
      id: "m_1",
      type: "chat" as const,
      authorId: "u_1",
      authorName: "Alice",
      content: "cached opener",
      createdAt: "2026-07-03T00:00:00.000Z",
      replyTo: { id: "m_0", authorName: "Bob", text: "parent" },
      attachments: [{ kind: "file" as const, name: "notes.txt", url: "/notes.txt", size: "1 KB" }],
      embeds: [{ title: "Reference" }],
      reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["u_1"] }],
    }
    apiFetchMock.mockResolvedValueOnce({
      messages: [cached],
      hasMore: false,
      latestSeq: 0,
    })
    const [{ createCommunityDbRegistry, registerCommunityDbRegistry }, { createLiveQueryCollection, eq }] = await Promise.all([
      import("@/lib/community-db/collections"),
      import("@tanstack/react-db"),
    ])
    const registry = createCommunityDbRegistry(qc, "viewer")
    await registry.ensureCollectionReady("messages")
    const unregister = registerCommunityDbRegistry(registry)
    const demand = {
      scope: { accountId: "viewer", kind: "server-channel" as const, serverId: "server-1", channelId: "channel-1" },
      tag: null,
      sequence: { base: { mode: "tail" as const }, direction: "older" as const, order: ["seq", "asc", "id", "asc"] as const },
    }
    registry.setMessageDemand(demand)
    const lease = registry.acquireMessageWindow(demand, 50)
    const view = createLiveQueryCollection({
      query: (q) => q.from({ message: registry.collections.messages })
        .where(({ message }) => eq(message.channelId, "channel-1"))
        .orderBy(({ message }) => message.id, "asc"),
    })
    await view.preload()
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
    await view.cleanup()
    await lease.release()
    unregister()
    await registry.cleanup()
    qc.clear()
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
