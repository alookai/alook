import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { getCanonicalCommunityMessages } from "@/lib/community-db/sync"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useThreads / threadsQueryFn", () => {
  it("fetches from /channels/:id/threads and returns { threads }", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ serverId: "s1", parentType: "forum", threads: [{ id: "t_1", name: "t", type: "thread", creatorId: "u1", parentMessageId: "m1", messageCount: 1, lastMessageAt: null, createdAt: "now" }] })
      .mockResolvedValueOnce({
        messages: [{ id: "m1", channelId: "ch_1", content: "root", seq: 1, createdAt: "now", authorId: "u1", authorName: "A", authorImage: null, authorAvatarVersion: 0 }],
        firstMessages: [{ channelId: "t_1", content: "identityless preview" }],
      })
      .mockResolvedValueOnce({ tags: [] })
      .mockResolvedValueOnce({ participants: [] })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const data = await threadsQueryFn("ch_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/ch_1/threads", { signal: undefined })
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/community/channels/ch_1/posts")
    expect(data.threads).toHaveLength(1)
    expect(data.threads[0]?.parent.text).toBe("identityless preview")
  })

  it("populates queryClient at communityKeys.threads(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ serverId: "s1", parentType: "text", threads: [{ id: "t_1", name: "thread", type: "thread", creatorId: "u1", parentMessageId: "m_1", messageCount: 1, lastMessageAt: null, createdAt: "now" }] })
      .mockResolvedValueOnce({ messages: [
        { id: "m_1", channelId: "ch_1", content: "root", seq: 1, createdAt: "now", authorId: "u1", authorName: "A", authorImage: "avatar.png", authorAvatarVersion: 1 },
        { id: "m_orphan", channelId: "ch_1", content: "orphan", seq: 2, createdAt: "now", authorId: "u1", authorName: "A", authorImage: null, authorAvatarVersion: 1 },
      ], firstMessages: [] })
      .mockResolvedValueOnce({ tags: [] })
      .mockResolvedValueOnce({ participants: [] })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const registry = createCommunityDbRegistry(qc, "viewer")
    const disposeRegistry = registry.cleanup.bind(registry)
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    const key = communityKeys.threads("ch_1")
    try {
      await qc.fetchQuery({ queryKey: key, queryFn: threadsQueryFn("ch_1", qc) })
      expect(qc.getQueryData<{ threads: unknown[] }>(key)?.threads).toHaveLength(1)
    } finally {
      unregister()
      await disposeRegistry()
    }
  })

  it("publishes a batch opener with stable date and thread geometry", async () => {
    apiFetchMock.mockResolvedValueOnce({ serverId: "s1", parentType: "text", threads: [{ id: "t_1", name: "thread", type: "thread", creatorId: "u1", parentMessageId: "m_1", messageCount: 1, lastMessageAt: "2026-09-28T00:01:00.000Z", createdAt: "2026-09-28T00:00:30.000Z" }] })
      .mockResolvedValueOnce({ messages: [{ id: "m_1", channelId: "ch_1", content: "root", seq: 1, createdAt: "2026-09-28T00:00:00.000Z", authorId: "u1", authorName: "A", authorImage: "avatar.png", authorAvatarVersion: 2 }], firstMessages: [] })
      .mockResolvedValueOnce({ tags: [] })
      .mockResolvedValueOnce({ participants: [] })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const registry = createCommunityDbRegistry(qc, "viewer")
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    try {
      await threadsQueryFn("ch_1", qc)()
      expect(getCanonicalCommunityMessages(qc)).toEqual([
        expect.objectContaining({
          id: "m_1",
          createdAt: "2026-09-28T00:00:00.000Z",
          authorAvatarVersion: 2,
          thread: expect.objectContaining({
            id: "t_1",
            messageCount: 1,
            lastReplyAt: "2026-09-28T00:01:00.000Z",
          }),
        }),
      ])
    } finally {
      unregister()
      await registry.cleanup()
    }
  })

  it("uses full opener content only for forum parents and shares one AbortSignal", async () => {
    const signal = new AbortController().signal
    apiFetchMock
      .mockResolvedValueOnce({ serverId: "s1", parentType: "forum", threads: [{ id: "post_1", name: "derived", type: "thread", creatorId: "u1", parentMessageId: "opener_1", messageCount: 1, lastMessageAt: null, createdAt: "now" }] })
      .mockResolvedValueOnce({ messages: [{ id: "opener_1", channelId: "forum_1", content: "  Full opener content  ", seq: 4, createdAt: "now", authorId: "u1", authorName: "A", authorImage: null, authorAvatarVersion: 0 }], firstMessages: [] })
      .mockResolvedValueOnce({ tags: [] })
      .mockResolvedValueOnce({ participants: [] })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const forum = await threadsQueryFn("forum_1")({ signal })
    expect(forum.threads[0]).toMatchObject({
      name: "  Full opener content  ",
      openerMessageId: "opener_1",
    })
    expect(apiFetchMock.mock.calls).toHaveLength(4)
    for (const call of apiFetchMock.mock.calls) expect(call[1]).toEqual(expect.objectContaining({ signal }))

    apiFetchMock.mockReset()
    apiFetchMock
      .mockResolvedValueOnce({ serverId: "s1", parentType: "text", threads: [{ id: "thread_1", name: "Custom thread name", type: "thread", creatorId: "u1", parentMessageId: "root_1", messageCount: 1, lastMessageAt: null, createdAt: "now" }] })
      .mockResolvedValueOnce({ messages: [{ id: "root_1", channelId: "text_1", content: "Root message", seq: 1, createdAt: "now", authorId: "u1", authorName: "A", authorImage: null, authorAvatarVersion: 0 }], firstMessages: [] })
      .mockResolvedValueOnce({ tags: [] })
      .mockResolvedValueOnce({ participants: [] })
    const text = await threadsQueryFn("text_1")()
    expect(text.threads[0]?.name).toBe("Custom thread name")
  })

  it("aborts all four loader requests when the exact base query is cancelled", async () => {
    const signals: AbortSignal[] = []
    apiFetchMock.mockImplementation((url: string, init: RequestInit = {}) => {
      const requestSignal = init.signal as AbortSignal
      signals.push(requestSignal)
      if (url.endsWith("/threads")) return Promise.resolve({ serverId: "s1", parentType: "forum", threads: [] })
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => reject(new Error("aborted")))
      })
    })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const key = communityKeys.threads("forum_1")
    const pending = qc.fetchQuery({ queryKey: key, queryFn: threadsQueryFn("forum_1") }).catch(() => undefined)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(4))
    await qc.cancelQueries({ queryKey: key, exact: true })
    expect(new Set(signals).size).toBe(1)
    expect(signals[0]?.aborted).toBe(true)
    await pending
  })
})

describe("usePins / pinsQueryFn", () => {
  it("fetches from /channels/:id/pins and returns { pins }", async () => {
    apiFetchMock.mockResolvedValueOnce({ pins: [{ id: "m_1" }] })
    const { pinsQueryFn } = await import("./use-channel-panels")
    const data = await pinsQueryFn("ch_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/ch_1/pins")
    expect(data.pins).toHaveLength(1)
  })

  it("populates queryClient at communityKeys.pins(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ pins: [{ id: "m_1", type: "chat", authorId: "u1", authorName: "A", content: "pin", createdAt: "now" }] })
    const { pinsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const registry = createCommunityDbRegistry(qc, "viewer")
    const disposeRegistry = registry.cleanup.bind(registry)
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    const key = communityKeys.pins("ch_1")
    try {
      await qc.fetchQuery({ queryKey: key, queryFn: pinsQueryFn("ch_1", qc) })
      expect(qc.getQueryData<{ pins: unknown[] }>(key)?.pins).toHaveLength(1)
    } finally {
      unregister()
      await disposeRegistry()
    }
  })
})

describe("materializeThreadsResponse", () => {
  it("filters missing openers and projects forum and text content from canonical rows", async () => {
    const { materializeThreadsResponse } = await import("./use-channel-panels")
    const base = {
      parentType: "forum" as const,
      serverId: "s1",
      parentChannelId: "forum_1",
      threads: [
        { id: "missing", name: "missing", messageCount: 0, lastMessageAt: "now", parent: { authorName: "", text: "preview" }, openerMessageId: "missing-opener" },
        { id: "post", name: "fallback", messageCount: 1, lastMessageAt: "now", parent: { authorName: "", text: "preview" }, openerMessageId: "opener" },
        { id: "identityless", name: "identityless", messageCount: 0, lastMessageAt: "now", parent: { authorName: "", text: "preview" } },
      ],
    }
    const canonical = new Map([["opener", { id: "opener", type: "chat" as const, authorId: "u1", authorName: "A", content: "Canonical title", createdAt: "now" }]])

    expect(materializeThreadsResponse(base, canonical).map(({ name }) => name))
      .toEqual(["Canonical title", "Post"])
    expect(materializeThreadsResponse({ ...base, parentType: "text" }, canonical)[0]?.parent.text)
      .toBe("Canonical title")
  })
})
