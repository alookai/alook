import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useDmMessages, useMessages, type MessagesPage } from "./use-messages"
import { useMessageStreamStore } from "@/stores/community/message-stream"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type Snapshot = { ids: string[]; isFetching: boolean }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
  expect(predicate()).toBe(true)
}

function DmCapture({ lastReadMessageId, onRender }: {
  lastReadMessageId: string | null | undefined
  onRender: (snapshot: Snapshot) => void
}) {
  const result = useDmMessages("dm_activation", { lastReadMessageId })
  onRender({ ids: result.messages.map((message) => message.id), isFetching: result.isFetching })
  return null
}

function ChannelCapture({ lastReadMessageId, onRender }: {
  lastReadMessageId: string | null | undefined
  onRender: (snapshot: Snapshot) => void
}) {
  const result = useMessages("ch_activation", { serverId: "server_1", lastReadMessageId })
  onRender({ ids: result.messages.map((message) => message.id), isFetching: result.isFetching })
  return null
}

function renderCapture(
  queryClient: QueryClient,
  element: React.ReactElement,
): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(QueryClientProvider, { client: queryClient }, element),
    )
  })
  return renderer
}

function updateCapture(
  renderer: TestRenderer.ReactTestRenderer,
  queryClient: QueryClient,
  element: React.ReactElement,
): void {
  act(() => {
    renderer.update(
      React.createElement(QueryClientProvider, { client: queryClient }, element),
    )
  })
}

beforeEach(() => {
  apiFetchMock.mockReset()
  useMessageStreamStore.getState().resetAll()
})

describe("useMessagesInner — disabled-to-enabled cache revalidation", () => {
  it("leaves browser network reconnect reconciliation to the bounded WS path", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.dmMessages("dm_activation"), {
      pages: [{
        messages: [{ id: "m_cached", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
        hasMore: false,
        latestSeq: 1,
      }],
      pageParams: [{ mode: "newest" }],
    })
    apiFetchMock.mockResolvedValue({
      messages: [{ id: "m_cached", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
      hasMore: false,
      latestSeq: 1,
    })
    const renderer = renderCapture(
      queryClient,
      React.createElement(DmCapture, {
        lastReadMessageId: null,
        onRender: () => undefined,
      }),
    )
    expect(queryClient.getQueryCache().find({
      queryKey: communityKeys.dmMessages("dm_activation"),
    })?.options.refetchOnReconnect).toBe(false)
    renderer.unmount()
  })

  it("refetches a fresh persisted empty DM on activation and converges to server truth", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } })
    queryClient.setQueryData(communityKeys.dmMessages("dm_activation"), {
      pages: [{ messages: [], hasMore: false, latestSeq: 0 }],
      pageParams: [{ mode: "newest" }],
    })
    const response = deferred<MessagesPage>()
    apiFetchMock.mockReturnValue(response.promise)
    const snapshots: Snapshot[] = []
    const onRender = (snapshot: Snapshot) => { snapshots.push(snapshot) }

    const renderer = renderCapture(
      queryClient,
      React.createElement(DmCapture, { lastReadMessageId: undefined, onRender }),
    )
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(snapshots.at(-1)?.ids).toEqual([])

    updateCapture(
      renderer,
      queryClient,
      React.createElement(DmCapture, { lastReadMessageId: null, onRender }),
    )
    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/dm_activation/messages",
      { signal: expect.any(AbortSignal) },
    )

    response.resolve({
      messages: [{ id: "m_server", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
      hasMore: false,
      latestSeq: 1,
    })
    await waitFor(() => snapshots.at(-1)?.ids.includes("m_server") === true)
    expect(snapshots.at(-1)?.ids).toEqual(["m_server"])
    renderer.unmount()
  })

  it("keeps a fresh nonempty DM cache painted while activation refetches in the background", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } })
    queryClient.setQueryData(communityKeys.dmMessages("dm_activation"), {
      pages: [{
        messages: [{ id: "m_cached", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
        hasMore: false,
        latestSeq: 1,
      }],
      pageParams: [{ mode: "newest" }],
    })
    const response = deferred<MessagesPage>()
    apiFetchMock.mockReturnValue(response.promise)
    const snapshots: Snapshot[] = []
    const onRender = (snapshot: Snapshot) => { snapshots.push(snapshot) }

    const renderer = renderCapture(
      queryClient,
      React.createElement(DmCapture, { lastReadMessageId: undefined, onRender }),
    )
    expect(snapshots.at(-1)?.ids).toEqual(["m_cached"])
    expect(apiFetchMock).not.toHaveBeenCalled()

    updateCapture(
      renderer,
      queryClient,
      React.createElement(DmCapture, { lastReadMessageId: null, onRender }),
    )
    await waitFor(() => snapshots.some((snapshot) => snapshot.isFetching))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    for (const snapshot of snapshots) expect(snapshot.ids.length).toBeGreaterThan(0)

    response.resolve({
      messages: [{ id: "m_server", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" }],
      hasMore: false,
      latestSeq: 2,
    })
    await waitFor(() => snapshots.at(-1)?.ids.includes("m_server") === true)
    for (const snapshot of snapshots) expect(snapshot.ids.length).toBeGreaterThan(0)
    expect(snapshots.at(-1)?.ids).toEqual(["m_server"])
    renderer.unmount()
  })

  it("revalidates the shared channel path without clearing or losing anchor pagination", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } })
    const key = communityKeys.channelMessages("ch_activation")
    queryClient.setQueryData(key, {
      pages: [
        {
          messages: [{ id: "m_anchor", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" }],
          hasMoreOlder: true,
          hasMoreNewer: false,
          olderCursor: "cached-cursor",
        },
        {
          messages: [{ id: "m_cached_old", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
          hasMoreOlder: false,
          hasMoreNewer: false,
        },
      ],
      pageParams: [
        { mode: "anchor", anchor: "m_anchor" },
        { mode: "older", cursor: "cached-cursor" },
      ],
    })
    const anchorResponse = deferred<MessagesPage>()
    const olderResponse = deferred<MessagesPage>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes("?anchor=m_anchor")) return anchorResponse.promise
      if (url.includes("?cursor=fresh-cursor")) return olderResponse.promise
      throw new Error(`unexpected messages URL: ${url}`)
    })
    const snapshots: Snapshot[] = []
    const onRender = (snapshot: Snapshot) => { snapshots.push(snapshot) }

    const renderer = renderCapture(
      queryClient,
      React.createElement(ChannelCapture, { lastReadMessageId: undefined, onRender }),
    )
    expect(snapshots.at(-1)?.ids).toEqual(["m_cached_old", "m_anchor"])
    expect(apiFetchMock).not.toHaveBeenCalled()

    updateCapture(
      renderer,
      queryClient,
      React.createElement(ChannelCapture, { lastReadMessageId: "m_anchor", onRender }),
    )
    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/community/channels/ch_activation/messages?anchor=m_anchor",
      { signal: expect.any(AbortSignal) },
    )
    for (const snapshot of snapshots) expect(snapshot.ids.length).toBeGreaterThan(0)

    anchorResponse.resolve({
      messages: [{ id: "m_anchor", seq: 3, createdAt: "2026-08-09T00:00:02.000Z" }],
      hasMoreOlder: true,
      hasMoreNewer: false,
      olderCursor: "fresh-cursor",
      latestSeq: 3,
    })
    await waitFor(() => apiFetchMock.mock.calls.length === 2)
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/community/channels/ch_activation/messages?cursor=fresh-cursor",
      { signal: expect.any(AbortSignal) },
    )
    for (const snapshot of snapshots) expect(snapshot.ids.length).toBeGreaterThan(0)

    olderResponse.resolve({
      messages: [{ id: "m_server_old", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" }],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 3,
    })
    await waitFor(() => snapshots.at(-1)?.ids.includes("m_server_old") === true)
    for (const snapshot of snapshots) expect(snapshot.ids.length).toBeGreaterThan(0)
    expect(snapshots.at(-1)?.ids).toEqual(["m_server_old", "m_anchor"])
    expect(queryClient.getQueryData(key)).toMatchObject({
      pages: [{ messages: [{ id: "m_anchor" }] }, { messages: [{ id: "m_server_old" }] }],
      pageParams: [
        { mode: "anchor", anchor: "m_anchor" },
        { mode: "older", cursor: "fresh-cursor" },
      ],
    })
    renderer.unmount()
  })
})
