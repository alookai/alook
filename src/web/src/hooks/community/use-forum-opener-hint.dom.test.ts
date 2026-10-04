import "fake-indexeddb/auto"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CONVERSATION_READ_TIMEOUT_MS } from "@/lib/community/conversation-read"
import { communityKeys } from "@/lib/query-keys"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  getCanonicalCommunityMessages,
  publishCommunityMessages,
} from "@/lib/community-db/sync"
import { useCommunityWsStore } from "@/stores/community/ws"
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

const cleanups: Array<() => void | Promise<void>> = []

beforeEach(() => {
  apiFetchMock.mockReset()


})

afterEach(async () => {
  await act(async () => { await Promise.all(cleanups.splice(0).map((dispose) => dispose())) })
})

async function canonicalSetup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(queryClient, "viewer")
  await registry.preload()
  const unregister = registerCommunityDbRegistry(registry)
  cleanups.push(unregister, registry.cleanup.bind(registry))
  const wrapper = ({ children }: PropsWithChildren) => createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(CommunityDbProvider, { registry }, children),
  )
  return { queryClient, wrapper }
}

describe("useForumOpenerHint", () => {
  it("times out a cold opener, rejects its late publication, and recovers through refetch", async () => {
    const { queryClient, wrapper } = await canonicalSetup()
    let release!: (value: unknown) => void
    const payload = { id: "opener-1", content: "Recovered title", seq: 7, channelId: "forum-1", type: "chat" }
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    vi.useFakeTimers()
    let rendered!: ReturnType<typeof renderHook<ReturnType<typeof useForumOpenerHint>, unknown>>
    try {
      rendered = renderHook(() => useForumOpenerHint("server-1", "opener-1", true), { wrapper })
      await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
      await act(async () => { await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS) })
      expect(queryClient.getQueryState(communityKeys.message("opener-1"))?.error).toMatchObject({ name: "ConversationReadTimeoutError" })
      expect(apiFetchMock.mock.calls[0]![1].signal.aborted).toBe(true)
    } finally { vi.useRealTimers() }
    await waitFor(() => expect(rendered.result.current.isError).toBe(true))
    expect(rendered.result.current.isLoading).toBe(false)
    await act(async () => { release(payload) })
    expect(getCanonicalCommunityMessages(queryClient)).toEqual([])
    apiFetchMock.mockResolvedValueOnce(payload)
    await act(async () => { await rendered.result.current.refetch() })
    await waitFor(() => expect(rendered.result.current.data?.content).toBe("Recovered title"))
    rendered.unmount()
  })

  it("keeps a readable canonical opener after a transient background failure", async () => {
    const { queryClient, wrapper } = await canonicalSetup()
    publishCommunityMessages(queryClient, { channelId: "forum-1", messages: [{ id: "opener-1", channelId: "forum-1", type: "chat", content: "Warm title", seq: 7 }], proof: { token: captureCommunityLiveSnapshotToken(queryClient), signal: undefined } })
    apiFetchMock.mockRejectedValue(new Error("offline"))
    const rendered = renderHook(() => useForumOpenerHint("server-1", "opener-1", true), { wrapper })
    await waitFor(() => expect(rendered.result.current.isError).toBe(true))
    expect(rendered.result.current.data?.content).toBe("Warm title")
    expect(rendered.result.current.isLoading).toBe(false)
    rendered.unmount()
  })

  it("does not fetch or authorize content before the route metadata is verified", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useForumOpenerHint("server-1", "opener-1", false), {
      wrapper: wrapperFor(queryClient),
    })

    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("refetches a legacy seeded hint that lacks the opener seq", async () => {
    const { queryClient, wrapper } = await canonicalSetup()
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
      wrapper,
    })

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/messages/opener-1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(queryClient.getQueryData(
      communityKeys.message("opener-1"),
    )).toEqual({ id: "opener-1" })
    const { getCanonicalCommunityMessages } = await import("@/lib/community-db/sync")
    expect(getCanonicalCommunityMessages(queryClient)).toEqual([expect.objectContaining({ id: "opener-1", content: "Seeded", seq: 7, channelId: "forum-1" })])
  })

  it("exposes a warm canonical opener without waiting for its background transport", async () => {
    const { queryClient, wrapper } = await canonicalSetup()
    publishCommunityMessages(queryClient, {
      channelId: "forum-1",
      messages: [{
        id: "opener-1",
        channelId: "forum-1",
        type: "chat",
        content: "Warm title",
        seq: 7,
      }],
      proof: {
        token: captureCommunityLiveSnapshotToken(queryClient),
        signal: undefined,
      },
    })
    apiFetchMock.mockReturnValue(new Promise(() => {}))

    const rendered = renderHook(
      () => useForumOpenerHint("server-1", "opener-1", true),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.data).toEqual({
      id: "opener-1",
      content: "Warm title",
      seq: 7,
    }))
    expect(rendered.result.current.fetchStatus).toBe("fetching")
    expect(rendered.result.current.isLoading).toBe(false)
    rendered.unmount()
  })

  it("keeps a cold canonical opener loading while its transport is pending", async () => {
    const { wrapper } = await canonicalSetup()
    apiFetchMock.mockReturnValue(new Promise(() => {}))

    const rendered = renderHook(
      () => useForumOpenerHint("server-1", "opener-1", true),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.fetchStatus).toBe("fetching"))
    expect(rendered.result.current.data).toBeUndefined()
    expect(rendered.result.current.isLoading).toBe(true)
    rendered.unmount()
  })

})
