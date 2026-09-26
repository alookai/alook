import "fake-indexeddb/auto"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
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
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
})

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dispose) => dispose()))
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
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/messages/opener-1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(queryClient.getQueryData(
      communityKeys.message("opener-1"),
    )).toEqual({
      id: "opener-1",
      content: "Seeded",
      seq: 7,
      channelId: "forum-1",
    })
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
