import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { useForumOpenerHint } from "./use-forum-opener-hint"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function wrapperFor(queryClient: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

beforeEach(() => apiFetchMock.mockReset())

describe("useForumOpenerHint", () => {
  it("does not fetch or authorize content before the route metadata is verified", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useForumOpenerHint("server-1", "opener-1", false), {
      wrapper: wrapperFor(queryClient),
    })

    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("refetches a legacy seeded hint that lacks the opener seq", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    apiFetchMock.mockResolvedValue({
      id: "opener-1",
      content: "Seeded",
      seq: 7,
      channelId: "forum-1",
    })
    queryClient.setQueryData(
      communityKeys.forumOpenerHint("server-1", "opener-1"),
      { id: "opener-1", content: "Seeded" },
    )
    renderHook(() => useForumOpenerHint("server-1", "opener-1", true), {
      wrapper: wrapperFor(queryClient),
    })

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/community/messages/opener-1")
    })
    expect(queryClient.getQueryData(
      communityKeys.forumOpenerHint("server-1", "opener-1"),
    )).toEqual({
      id: "opener-1",
      content: "Seeded",
      seq: 7,
      channelId: "forum-1",
    })
  })
})
