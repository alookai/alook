import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { useDmMessages, useMessages } from "./use-messages"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
  useMessageStreamStore.getState().resetAll()
})

function wrapperFor(queryClient: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

function renderChannelMessages(
  lastReadMessageId: string | null | undefined,
  seedTail?: { id: string; seq: number }[],
) {
  const queryClient = new QueryClient()
  if (seedTail) {
    queryClient.setQueryData(communityKeys.channelMessages("ch_new"), {
      pages: [{
        messages: seedTail,
        hasMore: false,
        latestSeq: seedTail.at(-1)?.seq ?? 0,
      }],
      pageParams: [{ mode: "newest" }],
    })
  }
  return renderHook(
    () => useMessages("ch_new", { serverId: "s1", lastReadMessageId }),
    { wrapper: wrapperFor(queryClient) },
  )
}

function renderDmMessages(seedTail: { id: string; seq: number }[]) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(communityKeys.dmMessages("dm_new"), {
    pages: [{
      messages: seedTail,
      hasMore: false,
      latestSeq: seedTail.at(-1)?.seq ?? 0,
    }],
    pageParams: [{ mode: "newest" }],
  })
  return renderHook(
    () => useDmMessages("dm_new", { lastReadMessageId: undefined }),
    { wrapper: wrapperFor(queryClient) },
  )
}

describe("useMessages — isLoading while the anchor snapshot is unresolved", () => {
  it("reports isLoading: true even though the underlying query is disabled", () => {
    const rendered = renderChannelMessages(undefined)

    expect(rendered.result.current.isLoading).toBe(true)
    expect(rendered.result.current.messages).toEqual([])
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("reports isLoading: true while the now-enabled query's first fetch is in flight", () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}))
    const rendered = renderChannelMessages(null)

    expect(rendered.result.current.isLoading).toBe(true)
  })
})

describe("useMessages — instant channel switch", () => {
  it("paints a warm cache without waiting on the anchor", () => {
    const rendered = renderChannelMessages(undefined, [
      { id: "m_1", seq: 1 },
      { id: "m_2", seq: 2 },
    ])

    expect(rendered.result.current.isLoading).toBe(false)
    expect(rendered.result.current.messages).toHaveLength(2)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("keeps the skeleton on a cold cache with the anchor unresolved", () => {
    const rendered = renderChannelMessages(undefined)

    expect(rendered.result.current.isLoading).toBe(true)
    expect(rendered.result.current.messages).toEqual([])
  })

  it("keeps latestSeq owned by the base snapshot when the overlay has a higher seq", () => {
    useMessageStreamStore.getState().dispatch(
      { kind: "channel", id: "ch_new", serverId: "s1" },
      {
        type: "wsMessage",
        message: {
          id: "m_live",
          seq: 99,
          type: "chat",
          authorId: "u1",
          authorName: "Alice",
          content: "live",
          createdAt: "2026-08-06T00:00:00.000Z",
        },
      },
    )
    const rendered = renderChannelMessages(undefined, [{ id: "m_base", seq: 5 }])

    expect(rendered.result.current.messages).toHaveLength(2)
    expect(rendered.result.current.latestSeq).toBe(5)
  })

  it("keeps the real server scope through baseChanged so removeServer clears it", () => {
    const messageScope = { kind: "channel" as const, id: "ch_new", serverId: "s1" }
    useMessageStreamStore.getState().dispatch(messageScope, {
      type: "wsMessage",
      message: {
        id: "m_live",
        seq: 9,
        type: "chat",
        authorId: "u1",
        authorName: "Alice",
        content: "live",
        createdAt: "2026-08-06T00:00:00.000Z",
      },
    })

    renderChannelMessages(undefined, [{ id: "m_base", seq: 5 }])
    expect([...useMessageStreamStore.getState().entries.values()][0]?.scope.serverId).toBe("s1")

    act(() => useMessageStreamStore.getState().removeServer("s1"))
    expect(useMessageStreamStore.getState().entries.size).toBe(0)
    expect(getMessageOverlay(messageScope).liveById.size).toBe(0)
  })
})

describe("useDmMessages — base plus overlay", () => {
  it("materializes a higher live fallback while latestSeq remains base-owned", () => {
    useMessageStreamStore.getState().dispatch(
      { kind: "dm", id: "dm_new" },
      {
        type: "wsMessage",
        message: {
          id: "m_live",
          seq: 99,
          type: "chat",
          authorId: "u1",
          authorName: "Alice",
          content: "live",
          createdAt: "2026-08-06T00:00:00.000Z",
        },
      },
    )
    const rendered = renderDmMessages([{ id: "m_base", seq: 5 }])

    expect(rendered.result.current.messages).toHaveLength(2)
    expect(rendered.result.current.latestSeq).toBe(5)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})
