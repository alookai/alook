import "fake-indexeddb/auto"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ingestMessages } from "@/lib/community-db/sync"
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

  it("tracks jump-to-present as newer activity without a sentinel request", async () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { refetchOnMount: false, retry: false } },
    })
    queryClient.setQueryData(communityKeys.channelMessages("ch_jump"), {
      pages: [{
        messages: [{ id: "m_base", seq: 5 }],
        hasMoreOlder: true,
        hasMoreNewer: true,
        newerCursor: "newer-cursor",
        latestSeq: 5,
      }],
      pageParams: [{ mode: "anchor", anchor: "m_base" }],
    })
    const rendered = renderHook(
      () => useMessages("ch_jump", { serverId: "s1", lastReadMessageId: "m_base" }),
      { wrapper: wrapperFor(queryClient) },
    )

    expect(rendered.result.current.isFetchingNewer).toBe(false)
    act(() => rendered.result.current.jumpToPresent())
    await waitFor(() => expect(rendered.result.current.isFetchingNewer).toBe(true))
  })

  it.each(["channel", "dm"] as const)(
    "keeps the %s window loading and withholds partial canonical rows until the full commit",
    async (kind) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { refetchOnMount: false, retry: false } },
      })
      const registry = createCommunityDbRegistry(queryClient, "viewer")
      const disposeRegistry = registry.cleanup.bind(registry)
      await registry.preload()
      const scopeId = `${kind}_canonical_gap`
      const queryKey = kind === "channel"
        ? communityKeys.channelMessages(scopeId)
        : communityKeys.dmMessages(scopeId)
      const messages = [
        {
          id: `${kind}_message_1`,
          type: "chat" as const,
          seq: 1,
          createdAt: "2026-08-09T00:00:00.000Z",
        },
        {
          id: `${kind}_message_2`,
          type: "chat" as const,
          seq: 2,
          createdAt: "2026-08-09T00:01:00.000Z",
        },
      ]
      queryClient.setQueryData(queryKey, {
        pages: [{ messages, hasMore: false, latestSeq: 2 }],
        pageParams: [{ mode: "newest" }],
      })
      const wrapper = ({ children }: PropsWithChildren) => createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(CommunityDbProvider, { registry }, children),
      )
      const rendered = renderHook(
        () => kind === "channel"
          ? useMessages(scopeId, { serverId: "s1", lastReadMessageId: undefined })
          : useDmMessages(scopeId, { lastReadMessageId: undefined }),
        { wrapper },
      )

      expect(rendered.result.current.isLoading).toBe(true)
      expect(rendered.result.current.messages).toEqual([])

      act(() => ingestMessages(registry, scopeId, [messages[0]!]))
      await waitFor(() => {
        expect(registry.collections.messages.get(messages[0]!.id)).toBeDefined()
      })
      expect(rendered.result.current.isLoading).toBe(true)
      expect(rendered.result.current.messages).toEqual([])

      act(() => ingestMessages(registry, scopeId, messages))
      await waitFor(() => {
        expect(rendered.result.current.isLoading).toBe(false)
        expect(rendered.result.current.messages.map((row) => row.id)).toEqual(
          messages.map((message) => message.id),
        )
      })

      rendered.unmount()
      await disposeRegistry()
    },
  )

  it.each(["channel", "dm"] as const)(
    "keeps the last complete %s window and pagination ownership until the expanded commit",
    async (kind) => {
      apiFetchMock.mockImplementation(() => new Promise(() => {}))
      const queryClient = new QueryClient({
        defaultOptions: { queries: { refetchOnMount: false, retry: false } },
      })
      const registry = createCommunityDbRegistry(queryClient, "viewer")
      const disposeRegistry = registry.cleanup.bind(registry)
      await registry.preload()
      const scopeId = `${kind}_canonical_pagination_gap`
      const queryKey = kind === "channel"
        ? communityKeys.channelMessages(scopeId)
        : communityKeys.dmMessages(scopeId)
      const older = {
        id: `${kind}_older_message`,
        type: "chat" as const,
        seq: 1,
        createdAt: "2026-08-09T00:00:00.000Z",
      }
      const initial = {
        id: `${kind}_initial_message`,
        type: "chat" as const,
        seq: 2,
        createdAt: "2026-08-09T00:01:00.000Z",
      }
      queryClient.setQueryData(queryKey, {
        pages: [{
          messages: [initial],
          hasMoreOlder: true,
          hasMoreNewer: false,
          olderCursor: "older-cursor",
          latestSeq: 2,
        }],
        pageParams: [{ mode: "anchor", anchor: initial.id }],
      })
      act(() => ingestMessages(registry, scopeId, [initial]))
      await waitFor(() => {
        expect(registry.collections.messages.get(initial.id)).toBeDefined()
      })
      const wrapper = ({ children }: PropsWithChildren) => createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(CommunityDbProvider, { registry }, children),
      )
      const rendered = renderHook(
        () => kind === "channel"
          ? useMessages(scopeId, { serverId: "s1", lastReadMessageId: null })
          : useDmMessages(scopeId, { lastReadMessageId: null }),
        { wrapper },
      )

      await waitFor(() => {
        expect(rendered.result.current.messages.map((row) => row.id)).toEqual([initial.id])
      })
      act(() => rendered.result.current.fetchOlder())
      await waitFor(() => expect(rendered.result.current.isFetchingOlder).toBe(true))

      act(() => {
        queryClient.setQueryData(queryKey, {
          pages: [
            {
              messages: [initial],
              hasMoreOlder: true,
              hasMoreNewer: false,
              olderCursor: "older-cursor",
              latestSeq: 2,
            },
            {
              messages: [older],
              hasMoreOlder: false,
              hasMoreNewer: false,
              latestSeq: 2,
            },
          ],
          pageParams: [
            { mode: "anchor", anchor: initial.id },
            { mode: "older", cursor: "older-cursor" },
          ],
        })
        void queryClient.cancelQueries({ queryKey, exact: true })
      })
      await waitFor(() => {
        expect(rendered.result.current.isLoading).toBe(false)
        expect(rendered.result.current.isFetchingOlder).toBe(true)
        expect(rendered.result.current.messages.map((row) => row.id)).toEqual([initial.id])
      })

      act(() => ingestMessages(registry, scopeId, [older]))
      await waitFor(() => {
        expect(rendered.result.current.isFetchingOlder).toBe(false)
        expect(rendered.result.current.messages.map((row) => row.id)).toEqual([
          older.id,
          initial.id,
        ])
      })

      rendered.unmount()
      await disposeRegistry()
    },
  )

  it("does not retain a complete channel window across a pending scope change", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { refetchOnMount: false, retry: false } },
    })
    const registry = createCommunityDbRegistry(queryClient, "viewer")
    const disposeRegistry = registry.cleanup.bind(registry)
    await registry.preload()
    const firstScope = "channel_committed"
    const secondScope = "channel_pending"
    const firstMessage = {
      id: "message_committed",
      type: "chat" as const,
      seq: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
    }
    const secondMessage = {
      id: "message_pending",
      type: "chat" as const,
      seq: 2,
      createdAt: "2026-08-09T00:01:00.000Z",
    }
    queryClient.setQueryData(communityKeys.channelMessages(firstScope), {
      pages: [{ messages: [firstMessage], hasMore: false, latestSeq: 1 }],
      pageParams: [{ mode: "newest" }],
    })
    queryClient.setQueryData(communityKeys.channelMessages(secondScope), {
      pages: [{ messages: [secondMessage], hasMore: false, latestSeq: 2 }],
      pageParams: [{ mode: "newest" }],
    })
    act(() => ingestMessages(registry, firstScope, [firstMessage]))
    await waitFor(() => {
      expect(registry.collections.messages.get(firstMessage.id)).toBeDefined()
    })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CommunityDbProvider, { registry }, children),
    )
    const rendered = renderHook(
      ({ scopeId }: { scopeId: string }) => useMessages(scopeId, {
        serverId: "s1",
        lastReadMessageId: undefined,
      }),
      { initialProps: { scopeId: firstScope }, wrapper },
    )

    await waitFor(() => {
      expect(rendered.result.current.messages.map((row) => row.id)).toEqual([firstMessage.id])
    })
    rendered.rerender({ scopeId: secondScope })
    expect(rendered.result.current).toMatchObject({
      messages: [],
      latestSeq: 0,
      isLoading: true,
    })

    rendered.unmount()
    await disposeRegistry()
  })

  it("keeps the complete window while newer pagination is projected", async () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {}))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { refetchOnMount: false, retry: false } },
    })
    const registry = createCommunityDbRegistry(queryClient, "viewer")
    const disposeRegistry = registry.cleanup.bind(registry)
    await registry.preload()
    const scopeId = "channel_newer_pagination_gap"
    const initial = {
      id: "channel_initial_message",
      type: "chat" as const,
      seq: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
    }
    const newer = {
      id: "channel_newer_message",
      type: "chat" as const,
      seq: 2,
      createdAt: "2026-08-09T00:01:00.000Z",
    }
    const queryKey = communityKeys.channelMessages(scopeId)
    queryClient.setQueryData(queryKey, {
      pages: [{
        messages: [initial],
        hasMoreOlder: false,
        hasMoreNewer: true,
        newerCursor: "newer-cursor",
        latestSeq: 1,
      }],
      pageParams: [{ mode: "anchor", anchor: initial.id }],
    })
    act(() => ingestMessages(registry, scopeId, [initial]))
    await waitFor(() => {
      expect(registry.collections.messages.get(initial.id)).toBeDefined()
    })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CommunityDbProvider, { registry }, children),
    )
    const rendered = renderHook(
      () => useMessages(scopeId, { serverId: "s1", lastReadMessageId: null }),
      { wrapper },
    )

    await waitFor(() => {
      expect(rendered.result.current.messages.map((row) => row.id)).toEqual([initial.id])
    })
    act(() => rendered.result.current.fetchNewer())
    await waitFor(() => expect(rendered.result.current.isFetchingNewer).toBe(true))

    act(() => {
      queryClient.setQueryData(queryKey, {
        pages: [
          {
            messages: [newer],
            hasMoreOlder: false,
            hasMoreNewer: false,
            latestSeq: 2,
          },
          {
            messages: [initial],
            hasMoreOlder: false,
            hasMoreNewer: true,
            newerCursor: "newer-cursor",
            latestSeq: 1,
          },
        ],
        pageParams: [
          { mode: "newer", since: "newer-cursor" },
          { mode: "anchor", anchor: initial.id },
        ],
      })
      void queryClient.cancelQueries({ queryKey, exact: true })
    })
    await waitFor(() => {
      expect(rendered.result.current.isFetchingNewer).toBe(true)
      expect(rendered.result.current.messages.map((row) => row.id)).toEqual([initial.id])
    })

    act(() => ingestMessages(registry, scopeId, [newer]))
    await waitFor(() => {
      expect(rendered.result.current.isFetchingNewer).toBe(false)
      expect(rendered.result.current.messages.map((row) => row.id)).toEqual([
        initial.id,
        newer.id,
      ])
    })

    rendered.unmount()
    await disposeRegistry()
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
