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
      .mockResolvedValueOnce({ serverId: "s1", parentType: "forum", threads: [{ id: "t_1", name: "t", type: "thread", creatorId: "u1", parentMessageId: "m1", messageCount: 1, lastMessageAt: null, createdAt: "now" }] })
      .mockResolvedValueOnce({ messages: [{ id: "m1", channelId: "ch_1", content: "root", seq: 1, authorId: "u1", authorName: "A", authorImage: null }], firstMessages: [] })
      .mockResolvedValueOnce({ tags: [] })
      .mockResolvedValueOnce({ participants: [] })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const data = await threadsQueryFn("ch_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/ch_1/threads", { signal: undefined })
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/community/channels/ch_1/posts")
    expect(data.threads).toHaveLength(1)
  })

  it("populates queryClient at communityKeys.threads(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ serverId: "s1", parentType: "text", threads: [] })
      .mockResolvedValueOnce({ messages: [], firstMessages: [] })
      .mockResolvedValueOnce({ tags: [] })
      .mockResolvedValueOnce({ participants: [] })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const key = communityKeys.threads("ch_1")
    await qc.fetchQuery({ queryKey: key, queryFn: threadsQueryFn("ch_1") })
    expect(qc.getQueryData(key)).toEqual({ threads: [], serverId: "s1", parentType: "text", parentChannelId: "ch_1" })
  })

  it("uses full opener content only for forum parents and shares one AbortSignal", async () => {
    const signal = new AbortController().signal
    apiFetchMock
      .mockResolvedValueOnce({ serverId: "s1", parentType: "forum", threads: [{ id: "post_1", name: "derived", type: "thread", creatorId: "u1", parentMessageId: "opener_1", messageCount: 1, lastMessageAt: null, createdAt: "now" }] })
      .mockResolvedValueOnce({ messages: [{ id: "opener_1", channelId: "forum_1", content: "  Full opener content  ", seq: 4, authorId: "u1", authorName: "A", authorImage: null }], firstMessages: [] })
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
      .mockResolvedValueOnce({ messages: [{ id: "root_1", channelId: "text_1", content: "Root message", seq: 1, authorId: "u1", authorName: "A", authorImage: null }], firstMessages: [] })
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
    apiFetchMock.mockResolvedValueOnce({ pins: [] })
    const { pinsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const key = communityKeys.pins("ch_1")
    await qc.fetchQuery({ queryKey: key, queryFn: pinsQueryFn("ch_1") })
    expect(qc.getQueryData(key)).toEqual({ pins: [] })
  })
})
