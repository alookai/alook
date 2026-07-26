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
  it("fetches from /channels/:id/children?type=thread and returns { children }", async () => {
    apiFetchMock.mockResolvedValueOnce({ children: [{ id: "t_1" }] })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const data = await threadsQueryFn("ch_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/ch_1/children?type=thread")
    expect(data.children).toHaveLength(1)
  })

  it("populates queryClient at communityKeys.threads(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ children: [] })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const key = communityKeys.threads("ch_1")
    await qc.fetchQuery({ queryKey: key, queryFn: threadsQueryFn("ch_1") })
    expect(qc.getQueryData(key)).toEqual({ children: [] })
  })
})

describe("useForumPosts / forumPostsQueryFn", () => {
  it("fetches from /channels/:id/children?type=post and returns { children }", async () => {
    apiFetchMock.mockResolvedValueOnce({ children: [{ id: "p_1" }] })
    const { forumPostsQueryFn } = await import("./use-channel-panels")
    const data = await forumPostsQueryFn("ch_1")()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/ch_1/children?type=post")
    expect(data.children).toHaveLength(1)
  })

  it("populates queryClient at communityKeys.forumPosts(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce({ children: [] })
    const { forumPostsQueryFn } = await import("./use-channel-panels")
    const qc = new QueryClient()
    const key = communityKeys.forumPosts("ch_1")
    await qc.fetchQuery({ queryKey: key, queryFn: forumPostsQueryFn("ch_1") })
    expect(qc.getQueryData(key)).toEqual({ children: [] })
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
