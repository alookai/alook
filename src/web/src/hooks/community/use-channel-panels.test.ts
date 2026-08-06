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

describe("useThreads / threadsQueryFn", () => {
  it("fetches from /channels/:id/threads and returns { threads }", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ threads: [{ id: "t_1", name: "t", type: "thread", creatorId: "u1", parentMessageId: "m1", messageCount: 1, lastMessageAt: null, createdAt: "now" }] })
      .mockResolvedValueOnce({ messages: [{ id: "m1", channelId: "ch_1", content: "root", seq: 1, authorId: "u1", authorName: "A", authorImage: null }], firstMessages: [] })
      .mockResolvedValueOnce({ tags: [] })
      .mockResolvedValueOnce({ participants: [] })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const data = await threadsQueryFn("ch_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/ch_1/threads")
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/community/channels/ch_1/posts")
    expect(data.threads).toHaveLength(1)
  })

  it("populates queryClient at communityKeys.threads(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ threads: [] })
      .mockResolvedValueOnce({ messages: [], firstMessages: [] })
      .mockResolvedValueOnce({ tags: [] })
      .mockResolvedValueOnce({ participants: [] })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const key = communityKeys.threads("ch_1")
    await qc.fetchQuery({ queryKey: key, queryFn: threadsQueryFn("ch_1") })
    expect(qc.getQueryData(key)).toEqual({ threads: [] })
  })
})

describe("useForumThreads / forumThreadsQueryFn", () => {
  it("composes posts from child threads plus generic batch resources", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ threads: [{ id: "p_1", name: "fallback", type: "thread", creatorId: "u1", parentMessageId: "m1", messageCount: 1, lastMessageAt: null, createdAt: "now" }] })
      .mockResolvedValueOnce({ messages: [{ id: "m1", channelId: "ch_1", content: "Title", seq: 1, authorId: "u1", authorName: "A", authorImage: null }], firstMessages: [{ id: "r1", channelId: "p_1", content: "Body", seq: 1, authorId: "u1", authorName: "A", authorImage: null }] })
      .mockResolvedValueOnce({ tags: [{ messageId: "m1", tag: "bug" }] })
      .mockResolvedValueOnce({ participants: [{ channelId: "p_1", userId: "u1", userName: "A", userImage: null, addedAt: "now" }] })
    const { forumThreadsQueryFn } = await import("./use-channel-panels")
    const data = await forumThreadsQueryFn("ch_1")()
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/community/channels/ch_1/posts")
    expect(data.threads).toHaveLength(1)
    expect(data.threads[0]).toEqual(expect.objectContaining({ name: "Title", preview: "Body", tags: ["bug"] }))
  })

  it("populates queryClient at communityKeys.forumThreads(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ threads: [] })
      .mockResolvedValueOnce({ messages: [], firstMessages: [] })
      .mockResolvedValueOnce({ tags: [] })
      .mockResolvedValueOnce({ participants: [] })
    const { forumThreadsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const key = communityKeys.forumThreads("ch_1")
    await qc.fetchQuery({ queryKey: key, queryFn: forumThreadsQueryFn("ch_1") })
    expect(qc.getQueryData(key)).toEqual({ threads: [] })
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
    apiFetchMock.mockResolvedValueOnce({ pins: [] })
    const { pinsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const key = communityKeys.pins("ch_1")
    await qc.fetchQuery({ queryKey: key, queryFn: pinsQueryFn("ch_1") })
    expect(qc.getQueryData(key)).toEqual({ pins: [] })
  })
})
