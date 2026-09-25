import { beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import {
  dehydrate,
  IsRestoringProvider,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import { act, render } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { useDmMessages, useMessages, type MessagesPage } from "./use-messages"
import { useDmReadStateSnapshot } from "./use-dm-read-state"
import { useMessageStreamStore } from "@/stores/community/message-stream"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type Snapshot = {
  anchorReconciled?: boolean
  hasMoreNewer?: boolean
  ids: string[]
  isFetching: boolean
}

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
  onRender({
    anchorReconciled: result.anchorReconciled,
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetching: result.isFetching,
  })
  return null
}

function RevalidatingDmCapture({ lastReadMessageId, onRender }: {
  lastReadMessageId: string | null | undefined
  onRender: (snapshot: Snapshot) => void
}) {
  const result = useDmMessages("dm_activation", {
    lastReadMessageId,
    waitForAnchor: true,
    reconcileLateAnchor: true,
    revalidateOnMount: true,
  })
  onRender({
    anchorReconciled: result.anchorReconciled,
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetching: result.isFetching,
  })
  return null
}

function DisabledDmRefetchProbe() {
  const { refetch } = useDmMessages("dm_activation", {
    lastReadMessageId: undefined,
    waitForAnchor: true,
    revalidateOnMount: true,
  })
  const requested = React.useRef(false)
  React.useLayoutEffect(() => {
    if (requested.current) return
    requested.current = true
    void refetch()
  }, [refetch])
  return null
}

function DmRouteCapture({ onRender }: {
  onRender: (snapshot: Snapshot & { readStateFetching: boolean }) => void
}) {
  const { snapshot, isFetching: readStateFetching } = useDmReadStateSnapshot("dm_activation")
  const result = useDmMessages("dm_activation", {
    lastReadMessageId: readStateFetching
      ? undefined
      : (snapshot?.lastReadMessageId ?? null),
    waitForAnchor: true,
    reconcileLateAnchor: true,
    revalidateOnMount: true,
    viewerUserId: "viewer_1",
  })
  onRender({
    anchorReconciled: result.anchorReconciled,
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetching: result.isFetching,
    readStateFetching,
  })
  return null
}

function ChannelCapture({ lastReadMessageId, onRender }: {
  lastReadMessageId: string | null | undefined
  onRender: (snapshot: Snapshot) => void
}) {
  const result = useMessages("ch_activation", { serverId: "server_1", lastReadMessageId })
  onRender({
    anchorReconciled: result.anchorReconciled,
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetching: result.isFetching,
  })
  return null
}

function PaginatingChannelCapture({ lastReadMessageId, onRender }: {
  lastReadMessageId: string | null | undefined
  onRender: (snapshot: Snapshot, fetchOlder: () => void) => void
}) {
  const result = useMessages("ch_activation", {
    serverId: "server_1",
    lastReadMessageId,
    revalidateOnMount: true,
  })
  onRender({
    anchorReconciled: result.anchorReconciled,
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetching: result.isFetching,
  }, result.fetchOlder)
  return null
}

function RefetchingPaginationCapture({ onRender }: {
  onRender: (
    snapshot: Snapshot,
    refetch: () => Promise<unknown>,
    fetchOlder: () => void,
  ) => void
}) {
  const result = useMessages("ch_activation", {
    serverId: "server_1",
    lastReadMessageId: "m_anchor",
    revalidateOnMount: false,
  })
  onRender({
    anchorReconciled: result.anchorReconciled,
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetching: result.isFetching,
  }, result.refetch, result.fetchOlder)
  return null
}

function LayoutPaginatingChannelCapture({ lastReadMessageId, onRender }: {
  lastReadMessageId: string
  onRender: (snapshot: Snapshot) => void
}) {
  const result = useMessages("ch_activation", {
    serverId: "server_1",
    lastReadMessageId,
    revalidateOnMount: true,
  })
  const fetchOlder = result.fetchOlder
  const requested = React.useRef(false)
  React.useLayoutEffect(() => {
    if (requested.current) return
    requested.current = true
    fetchOlder()
  }, [fetchOlder])
  onRender({
    anchorReconciled: result.anchorReconciled,
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetching: result.isFetching,
  })
  return null
}

function SwitchingLayoutPaginationCapture({ channelId, queueOlder, onRender }: {
  channelId: string
  queueOlder: boolean
  onRender: (snapshot: Snapshot) => void
}) {
  const result = useMessages(channelId, {
    serverId: "server_1",
    lastReadMessageId: `m_anchor_${channelId}`,
    revalidateOnMount: queueOlder,
  })
  const fetchOlder = result.fetchOlder
  const queuedFor = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (!queueOlder || queuedFor.current === channelId) return
    queuedFor.current = channelId
    fetchOlder()
  }, [channelId, fetchOlder, queueOlder])
  onRender({
    anchorReconciled: result.anchorReconciled,
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetching: result.isFetching,
  })
  return null
}

function IndependentChannelCapture({ lastReadMessageId, onRender }: {
  lastReadMessageId: string | null | undefined
  onRender: (snapshot: Snapshot) => void
}) {
  const result = useMessages("ch_activation", {
    serverId: "server_1",
    lastReadMessageId,
    waitForAnchor: false,
  })
  onRender({
    anchorReconciled: result.anchorReconciled,
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetching: result.isFetching,
  })
  return null
}

function WarmReturnChannelCapture({ lastReadMessageId, onRender }: {
  lastReadMessageId: string | null
  onRender: (snapshot: Snapshot) => void
}) {
  const result = useMessages("ch_activation", {
    serverId: "server_1",
    lastReadMessageId,
    waitForAnchor: false,
    reconcileLateAnchor: false,
    revalidateOnMount: false,
  })
  onRender({
    anchorReconciled: result.anchorReconciled,
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetching: result.isFetching,
  })
  return null
}

function renderCapture(
  queryClient: QueryClient,
  element: React.ReactElement,
): ReturnType<typeof render> {
  return render(React.createElement(QueryClientProvider, { client: queryClient }, element))
}

function updateCapture(
  renderer: ReturnType<typeof render>,
  queryClient: QueryClient,
  element: React.ReactElement,
): void {
  act(() => {
    renderer.rerender(
      React.createElement(QueryClientProvider, { client: queryClient }, element),
    )
  })
}

beforeEach(() => {
  apiFetchMock.mockReset()
  useMessageStreamStore.getState().resetAll()
})

describe("useMessagesInner — disabled-to-enabled cache revalidation", () => {
  it("keeps the real transport installed while the anchor gate is disabled", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    apiFetchMock.mockResolvedValue({
      messages: [],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 0,
    } satisfies MessagesPage)

    const renderer = renderCapture(
      queryClient,
      React.createElement(DisabledDmRefetchProbe),
    )

    await waitFor(() => apiFetchMock.mock.calls.some(
      ([url]) => url === "/api/community/channels/dm_activation/messages",
    ))
    renderer.unmount()
  })

  it("uses the refreshed anchor when retained DM messages and read-state mount together", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKey = communityKeys.dmMessages("dm_activation")
    const cachedPage = {
      messages: [
        { id: "m_retained", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" },
        { id: "m_fresh", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" },
      ],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 2,
    } satisfies MessagesPage
    queryClient.setQueryData(
      queryKey,
      {
        pages: [cachedPage],
        pageParams: [{ mode: "anchor", anchor: "m_retained" }],
      },
      { updatedAt: Date.now() },
    )
    queryClient.setQueryData(
      communityKeys.dmReadStateSnapshot("dm_activation"),
      {
        lastReadMessageId: "m_retained",
        lastReadAt: "2026-08-09T00:00:00.000Z",
        lastReadSeq: 1,
      },
      { updatedAt: Date.now() },
    )
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
    const readStateResponse = deferred<{
      lastReadMessageId: string
      lastReadAt: string
      lastReadSeq: number
    }>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/read-state")) return readStateResponse.promise
      return Promise.resolve({
        messages: [{ id: "m_fresh", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" }],
        hasMoreOlder: false,
        hasMoreNewer: false,
        latestSeq: 2,
      } satisfies MessagesPage)
    })
    const snapshots: Array<Snapshot & { readStateFetching: boolean }> = []
    const renderer = renderCapture(
      queryClient,
      React.createElement(DmRouteCapture, {
        onRender: (snapshot) => { snapshots.push(snapshot) },
      }),
    )

    expect(snapshots.at(-1)?.ids).toEqual(["m_retained", "m_fresh"])
    expect(snapshots.at(-1)?.readStateFetching).toBe(true)
    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/community/channels/dm_activation/read-state",
    ])

    readStateResponse.resolve({
      lastReadMessageId: "m_fresh",
      lastReadAt: "2026-08-09T00:00:01.000Z",
      lastReadSeq: 2,
    })
    await waitFor(() => apiFetchMock.mock.calls.filter(
      ([url]) => url.includes("/messages"),
    ).length === 1)
    await waitFor(() => snapshots.at(-1)?.anchorReconciled === true)

    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/api/community/channels/dm_activation/messages?anchor=m_fresh",
      { signal: expect.any(AbortSignal) },
    )
    expect(invalidateQueries).not.toHaveBeenCalled()
    expect(snapshots.every((snapshot) => snapshot.ids.length > 0)).toBe(true)
    renderer.unmount()
  })

  it("revalidates a restored DM cache after read-state becomes ready", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKey = communityKeys.dmMessages("dm_activation")
    const cachedPage = {
      messages: [{ id: "m_anchor", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 1,
    } satisfies MessagesPage
    queryClient.setQueryData(
      queryKey,
      {
        pages: [cachedPage],
        pageParams: [{ mode: "anchor", anchor: "m_anchor" }],
      },
      { updatedAt: Date.now() - 60_000 },
    )
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
    const readStateResponse = deferred<{
      lastReadMessageId: string
      lastReadAt: string
      lastReadSeq: number
    }>()
    const messageSignals: AbortSignal[] = []
    apiFetchMock.mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
      if (url.endsWith("/read-state")) return readStateResponse.promise
      const signal = init?.signal
      if (!signal) throw new Error("messages request requires an abort signal")
      messageSignals.push(signal)
      return new Promise<MessagesPage>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"))
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
      })
    })
    const snapshots: Array<Snapshot & { readStateFetching: boolean }> = []
    const onRender = (snapshot: Snapshot & { readStateFetching: boolean }) => {
      snapshots.push(snapshot)
    }
    const view = (isRestoring: boolean) => (
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          IsRestoringProvider,
          { value: isRestoring },
          React.createElement(DmRouteCapture, { onRender }),
        ),
      )
    )

    const renderer = render(view(true))
    expect(snapshots.at(-1)?.ids).toEqual(["m_anchor"])
    expect(apiFetchMock).not.toHaveBeenCalled()

    act(() => { renderer.rerender(view(false)) })
    await waitFor(() => apiFetchMock.mock.calls.some(
      ([url]) => url === "/api/community/channels/dm_activation/read-state",
    ))
    expect(messageSignals).toHaveLength(0)
    expect(snapshots.at(-1)?.ids).toEqual(["m_anchor"])

    readStateResponse.resolve({
      lastReadMessageId: "m_anchor",
      lastReadAt: "2026-08-09T00:00:00.000Z",
      lastReadSeq: 1,
    })
    await waitFor(() => apiFetchMock.mock.calls.filter(
      ([url]) => url.includes("/messages"),
    ).length === 1)
    expect(apiFetchMock.mock.calls.filter(
      ([url]) => url.includes("/messages"),
    )).toEqual([
      [
        "/api/community/channels/dm_activation/messages?anchor=m_anchor",
        { signal: expect.any(AbortSignal) },
      ],
    ])
    expect(invalidateQueries).not.toHaveBeenCalled()
    expect(snapshots.every((snapshot) => snapshot.ids.length > 0)).toBe(true)
    renderer.unmount()
  })

  it("guarantees cached revalidation when restore and anchor resolution finish before mount", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { refetchOnMount: false, retry: false } },
    })
    const queryKey = communityKeys.dmMessages("dm_activation")
    const cachedPage = {
      messages: [{ id: "m_anchor", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 1,
    } satisfies MessagesPage
    queryClient.setQueryData(queryKey, {
      pages: [cachedPage],
      pageParams: [{ mode: "anchor", anchor: "m_anchor" }],
    })
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    apiFetchMock.mockResolvedValue(cachedPage)
    const snapshots: Snapshot[] = []
    const view = (isRestoring: boolean) => (
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          IsRestoringProvider,
          { value: isRestoring },
          React.createElement(RevalidatingDmCapture, {
            lastReadMessageId: "m_anchor",
            onRender: (snapshot) => { snapshots.push(snapshot) },
          }),
        ),
      )
    )

    const renderer = render(view(false))

    await waitFor(() => apiFetchMock.mock.calls.filter(
      ([url]) => url.includes("/messages"),
    ).length === 1)
    expect(invalidateQueries).not.toHaveBeenCalled()
    expect(snapshots.every((snapshot) => snapshot.ids.length > 0)).toBe(true)
    renderer.unmount()
  })

  it("does not fabricate cache data if normalization observes a vanished entry", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const cachedPage = {
      messages: [{ id: "m_anchor", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 1,
    } satisfies MessagesPage
    queryClient.setQueryData(communityKeys.dmMessages("dm_activation"), {
      pages: [cachedPage],
      pageParams: [{ mode: "anchor", anchor: "m_anchor" }],
    })
    apiFetchMock.mockResolvedValue(cachedPage)
    const setQueryData = vi.spyOn(queryClient, "setQueryData")
    setQueryData.mockImplementationOnce(((
      _queryKey: readonly unknown[],
      updater: unknown,
    ) => {
      expect(typeof updater).toBe("function")
      expect((updater as (current: undefined) => unknown)(undefined)).toBeUndefined()
      return undefined
    }) as typeof queryClient.setQueryData)
    const snapshots: Snapshot[] = []
    const renderer = renderCapture(
      queryClient,
      React.createElement(RevalidatingDmCapture, {
        lastReadMessageId: "m_anchor",
        onRender: (snapshot) => { snapshots.push(snapshot) },
      }),
    )

    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/dm_activation/messages?anchor=m_anchor",
      { signal: expect.any(AbortSignal) },
    )
    expect(snapshots.every((snapshot) => snapshot.ids.length > 0)).toBe(true)
    renderer.unmount()
  })

  it("refetches the mounted observer after persisted messages hydrate before read-state", async () => {
    const restoredClient = new QueryClient()
    const cachedPage = {
      messages: [{ id: "m_anchor", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 1,
    } satisfies MessagesPage
    restoredClient.setQueryData(communityKeys.dmMessages("dm_activation"), {
      pages: [cachedPage],
      pageParams: [{ mode: "anchor", anchor: "m_anchor" }],
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { refetchOnMount: false, retry: false } },
    })
    const restore = deferred<{
      buster: string
      clientState: ReturnType<typeof dehydrate>
      timestamp: number
    }>()
    const persister = {
      persistClient: vi.fn(() => Promise.resolve()),
      removeClient: vi.fn(() => Promise.resolve()),
      restoreClient: vi.fn(() => restore.promise),
    }
    const readStateResponse = deferred<{
      lastReadMessageId: string
      lastReadAt: string
      lastReadSeq: number
    }>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/read-state")) return readStateResponse.promise
      return Promise.resolve(cachedPage)
    })
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    const snapshots: Array<Snapshot & { readStateFetching: boolean }> = []
    const renderer = render(
      React.createElement(
        PersistQueryClientProvider,
        {
          client: queryClient,
          persistOptions: { buster: "activation", persister },
        },
        React.createElement(DmRouteCapture, {
          onRender: (snapshot) => { snapshots.push(snapshot) },
        }),
      ),
    )

    expect(apiFetchMock).not.toHaveBeenCalled()
    restore.resolve({
      buster: "activation",
      clientState: dehydrate(restoredClient),
      timestamp: Date.now(),
    })
    await waitFor(() => apiFetchMock.mock.calls.some(
      ([url]) => url.endsWith("/read-state"),
    ))
    expect(snapshots.at(-1)?.ids).toEqual(["m_anchor"])
    expect(apiFetchMock.mock.calls.filter(([url]) => url.includes("/messages"))).toHaveLength(0)

    readStateResponse.resolve({
      lastReadMessageId: "m_anchor",
      lastReadAt: "2026-08-09T00:00:00.000Z",
      lastReadSeq: 1,
    })
    await waitFor(() => apiFetchMock.mock.calls.filter(
      ([url]) => url.includes("/messages"),
    ).length === 1)

    expect(apiFetchMock.mock.calls.filter(([url]) => url.includes("/messages"))).toEqual([
      ["/api/community/channels/dm_activation/messages?anchor=m_anchor", {
        signal: expect.any(AbortSignal),
      }],
    ])
    expect(invalidateQueries).not.toHaveBeenCalled()
    const hydratedAt = snapshots.findIndex((snapshot) => snapshot.ids.length > 0)
    expect(hydratedAt).toBeGreaterThanOrEqual(0)
    expect(snapshots.slice(hydratedAt).every((snapshot) => snapshot.ids.length > 0)).toBe(true)
    renderer.unmount()
  })

  it("revalidates a warm DM again after an unmount and same-client remount", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { refetchOnMount: false, retry: false } },
    })
    const cachedPage = {
      messages: [{ id: "m_anchor", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 1,
    } satisfies MessagesPage
    queryClient.setQueryData(communityKeys.dmMessages("dm_activation"), {
      pages: [cachedPage],
      pageParams: [{ mode: "anchor", anchor: "m_anchor" }],
    })
    queryClient.setQueryData(communityKeys.dmReadStateSnapshot("dm_activation"), {
      lastReadMessageId: "m_anchor",
      lastReadAt: "2026-08-09T00:00:00.000Z",
      lastReadSeq: 1,
    })
    apiFetchMock.mockImplementation((url: string) => url.endsWith("/read-state")
      ? Promise.resolve({
          lastReadMessageId: "m_anchor",
          lastReadAt: "2026-08-09T00:00:00.000Z",
          lastReadSeq: 1,
        })
      : Promise.resolve(cachedPage))
    const snapshots: Array<Snapshot & { readStateFetching: boolean }> = []
    const element = React.createElement(DmRouteCapture, {
      onRender: (snapshot) => { snapshots.push(snapshot) },
    })

    const first = renderCapture(queryClient, element)
    await waitFor(() => apiFetchMock.mock.calls.filter(
      ([url]) => url.includes("/messages"),
    ).length === 1)
    await waitFor(() => snapshots.at(-1)?.isFetching === false
      && snapshots.at(-1)?.readStateFetching === false)
    first.unmount()

    apiFetchMock.mockClear()
    const second = renderCapture(queryClient, element)
    await waitFor(() => apiFetchMock.mock.calls.filter(
      ([url]) => url.includes("/messages"),
    ).length === 1)
    expect(apiFetchMock.mock.calls.filter(
      ([url]) => url.includes("/messages"),
    )).toEqual([["/api/community/channels/dm_activation/messages?anchor=m_anchor", {
      signal: expect.any(AbortSignal),
    }]])
    expect(snapshots.every((snapshot) => snapshot.ids.length > 0)).toBe(true)
    second.unmount()
  })

  it("does not duplicate a messages request that actually fetched after mount", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKey = communityKeys.dmMessages("dm_activation")
    const cachedPage = {
      messages: [{ id: "m_anchor", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 1,
    } satisfies MessagesPage
    queryClient.setQueryData(queryKey, {
      pages: [cachedPage],
      pageParams: [{ mode: "anchor", anchor: "m_anchor" }],
    })
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
    const readStateResponse = deferred<{
      lastReadMessageId: string
      lastReadAt: string
      lastReadSeq: number
    }>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/read-state")) return readStateResponse.promise
      return Promise.resolve(cachedPage)
    })
    const snapshots: Array<Snapshot & { readStateFetching: boolean }> = []
    const renderer = renderCapture(
      queryClient,
      React.createElement(DmRouteCapture, {
        onRender: (snapshot) => { snapshots.push(snapshot) },
      }),
    )
    expect(snapshots.at(-1)?.readStateFetching).toBe(true)

    await act(async () => {
      await queryClient.fetchInfiniteQuery({
        queryKey,
        queryFn: () => apiFetchMock(
          "/api/community/channels/dm_activation/messages?anchor=m_anchor",
        ) as Promise<MessagesPage>,
        initialPageParam: { mode: "anchor", anchor: "m_anchor" },
        getNextPageParam: () => undefined,
      })
    })
    expect(apiFetchMock.mock.calls.filter(([url]) => url.includes("/messages"))).toHaveLength(1)

    readStateResponse.resolve({
      lastReadMessageId: "m_anchor",
      lastReadAt: "2026-08-09T00:00:00.000Z",
      lastReadSeq: 1,
    })
    await waitFor(() => snapshots.at(-1)?.readStateFetching === false)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    expect(invalidateQueries).not.toHaveBeenCalled()
    expect(apiFetchMock.mock.calls.filter(([url]) => url.includes("/messages"))).toHaveLength(1)
    renderer.unmount()
  })

  it("revalidates after an anchor-gated retained-cache write advances dataUpdatedAt", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const queryKey = communityKeys.dmMessages("dm_activation")
    const cachedPage = {
      messages: [{ id: "m_anchor", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: 1,
    } satisfies MessagesPage
    queryClient.setQueryData(queryKey, {
      pages: [cachedPage],
      pageParams: [{ mode: "anchor", anchor: "m_anchor" }],
    })
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
    const readStateResponse = deferred<{
      lastReadMessageId: string
      lastReadAt: string
      lastReadSeq: number
    }>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/read-state")) return readStateResponse.promise
      return Promise.resolve(cachedPage)
    })
    const snapshots: Array<Snapshot & { readStateFetching: boolean }> = []
    const renderer = renderCapture(
      queryClient,
      React.createElement(DmRouteCapture, {
        onRender: (snapshot) => { snapshots.push(snapshot) },
      }),
    )

    expect(snapshots.at(-1)?.readStateFetching).toBe(true)
    act(() => {
      queryClient.setQueryData(queryKey, (current: unknown) => ({
        ...(current as object),
      }))
    })

    readStateResponse.resolve({
      lastReadMessageId: "m_anchor",
      lastReadAt: "2026-08-09T00:00:00.000Z",
      lastReadSeq: 1,
    })
    await waitFor(() => apiFetchMock.mock.calls.filter(
      ([url]) => url.includes("/messages"),
    ).length === 1)

    expect(invalidateQueries).not.toHaveBeenCalled()
    expect(snapshots.every((snapshot) => snapshot.ids.length > 0)).toBe(true)
    renderer.unmount()
  })

  it("starts newest messages without waiting for read-state, then repairs a late anchor", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const newest = deferred<MessagesPage>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("?anchor=m_read")) {
        return Promise.resolve({
          messages: [{ id: "m_read", seq: 2, createdAt: "2026-08-09T00:00:02.000Z" }],
          hasMoreOlder: true,
          hasMoreNewer: true,
          latestSeq: 3,
        })
      }
      return newest.promise
    })
    const snapshots: Snapshot[] = []
    const onRender = (snapshot: Snapshot) => { snapshots.push(snapshot) }

    const renderer = renderCapture(
      queryClient,
      React.createElement(IndependentChannelCapture, {
        lastReadMessageId: undefined,
        onRender,
      }),
    )

    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/ch_activation/messages",
      { signal: expect.any(AbortSignal) },
    )

    newest.resolve({
      messages: [{ id: "m_new", seq: 3, createdAt: "2026-08-09T00:00:03.000Z" }],
      hasMore: true,
      cursor: "older",
      latestSeq: 3,
    })
    await waitFor(() => snapshots.at(-1)?.ids.includes("m_new") === true)

    updateCapture(
      renderer,
      queryClient,
      React.createElement(IndependentChannelCapture, {
        lastReadMessageId: "m_read",
        onRender,
      }),
    )
    await waitFor(() => apiFetchMock.mock.calls.some(
      ([url]) => url === "/api/community/channels/ch_activation/messages?anchor=m_read",
    ))
    await waitFor(() => snapshots.at(-1)?.ids.includes("m_read") === true)
    renderer.unmount()
  })

  it("reconciles a late anchor already present in the newest page without replacing painted rows", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    apiFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("?anchor=m_read")) {
        return Promise.resolve({
          messages: [{ id: "m_read", seq: 1, createdAt: "2026-08-09T00:00:01.000Z" }],
          hasMoreOlder: false,
          hasMoreNewer: true,
          newerCursor: "m_read",
          latestSeq: 2,
        } satisfies MessagesPage)
      }
      return Promise.resolve({
        messages: [
          { id: "m_read", seq: 1, createdAt: "2026-08-09T00:00:01.000Z" },
          { id: "m_new", seq: 2, createdAt: "2026-08-09T00:00:02.000Z" },
        ],
        hasMore: false,
        latestSeq: 2,
      } satisfies MessagesPage)
    })
    const snapshots: Snapshot[] = []
    const onRender = (snapshot: Snapshot) => { snapshots.push(snapshot) }
    const renderer = renderCapture(
      queryClient,
      React.createElement(IndependentChannelCapture, {
        lastReadMessageId: undefined,
        onRender,
      }),
    )

    await waitFor(() => snapshots.at(-1)?.ids.includes("m_new") === true)
    expect(snapshots.at(-1)?.anchorReconciled).toBe(true)
    expect(snapshots.at(-1)?.hasMoreNewer).toBe(false)

    updateCapture(
      renderer,
      queryClient,
      React.createElement(IndependentChannelCapture, {
        lastReadMessageId: "m_read",
        onRender,
      }),
    )
    await waitFor(() => snapshots.at(-1)?.anchorReconciled === true)

    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/community/channels/ch_activation/messages",
      "/api/community/channels/ch_activation/messages?anchor=m_read",
    ])
    expect(snapshots.at(-1)?.ids).toEqual(["m_read", "m_new"])
    expect(snapshots.at(-1)?.hasMoreNewer).toBe(true)
    renderer.unmount()
  })

  it("warm return keeps its WS-live cache without StrictMode mount refetch when the read pointer is already cached", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = communityKeys.channelMessages("ch_activation")
    const page = {
      messages: [
        { id: "m_read", seq: 1, createdAt: "2026-08-09T00:00:01.000Z" },
        { id: "m_new", seq: 2, createdAt: "2026-08-09T00:00:02.000Z" },
      ],
      hasMore: false,
      latestSeq: 2,
    } satisfies MessagesPage
    queryClient.setQueryData(key, {
      pages: [page],
      pageParams: [{ mode: "newest" }],
    })
    apiFetchMock.mockResolvedValue(page)
    const snapshots: Snapshot[] = []
    const renderer = renderCapture(
      queryClient,
      React.createElement(WarmReturnChannelCapture, {
        lastReadMessageId: "m_read",
        onRender: (snapshot) => { snapshots.push(snapshot) },
      }),
    )

    await act(async () => { await Promise.resolve() })
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(snapshots.at(-1)?.anchorReconciled).toBe(true)
    expect(snapshots.at(-1)?.ids).toEqual(["m_read", "m_new"])
    renderer.unmount()
  })

  it("warm return performs one anchor repair when the read pointer is genuinely absent", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = communityKeys.channelMessages("ch_activation")
    queryClient.setQueryData(key, {
      pages: [{
        messages: [{ id: "m_new", seq: 2, createdAt: "2026-08-09T00:00:02.000Z" }],
        hasMore: true,
        latestSeq: 2,
      }],
      pageParams: [{ mode: "newest" }],
    })
    apiFetchMock.mockResolvedValue({
      messages: [{ id: "m_read", seq: 1, createdAt: "2026-08-09T00:00:01.000Z" }],
      hasMoreOlder: false,
      hasMoreNewer: true,
      latestSeq: 2,
    } satisfies MessagesPage)
    const snapshots: Snapshot[] = []
    const renderer = renderCapture(
      queryClient,
      React.createElement(WarmReturnChannelCapture, {
        lastReadMessageId: "m_read",
        onRender: (snapshot) => { snapshots.push(snapshot) },
      }),
    )

    await waitFor(() => snapshots.at(-1)?.anchorReconciled === true)
    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/community/channels/ch_activation/messages?anchor=m_read",
    ])
    expect(snapshots.at(-1)?.ids).toEqual(["m_read", "m_new"])
    renderer.unmount()
  })

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

  it("keeps the resolved anchor ahead of pagination on a retained mount", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = communityKeys.channelMessages("ch_activation")
    queryClient.setQueryData(key, {
      pages: [{
        messages: [{ id: "m_anchor", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" }],
        hasMoreOlder: true,
        hasMoreNewer: false,
        olderCursor: "persisted-cursor",
        latestSeq: 2,
      }],
      pageParams: [{ mode: "older", cursor: "persisted-cursor" }],
    })
    const anchorResponse = deferred<MessagesPage>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("?anchor=m_anchor")) return anchorResponse.promise
      if (url.endsWith("?cursor=fresh-cursor")) {
        return Promise.resolve({
          messages: [{ id: "m_old", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
          hasMoreOlder: false,
          hasMoreNewer: false,
          latestSeq: 2,
        } satisfies MessagesPage)
      }
      throw new Error(`unexpected messages URL: ${url}`)
    })
    const snapshots: Snapshot[] = []
    let fetchOlder = () => {}
    const onRender = (snapshot: Snapshot, nextFetchOlder: () => void) => {
      snapshots.push(snapshot)
      fetchOlder = nextFetchOlder
    }
    const view = (lastReadMessageId: string | undefined) => React.createElement(
      PaginatingChannelCapture,
      { lastReadMessageId, onRender },
    )
    const renderer = renderCapture(queryClient, view(undefined))

    updateCapture(renderer, queryClient, view("m_anchor"))
    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(
      "/api/community/channels/ch_activation/messages?anchor=m_anchor",
    )
    await waitFor(() => snapshots.at(-1)?.isFetching === true)

    act(() => fetchOlder())
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    anchorResponse.resolve({
      messages: [{ id: "m_anchor", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" }],
      hasMoreOlder: true,
      hasMoreNewer: false,
      olderCursor: "fresh-cursor",
      latestSeq: 2,
    })
    await waitFor(() => apiFetchMock.mock.calls.length === 2)
    expect(apiFetchMock.mock.calls[1]?.[0]).toBe(
      "/api/community/channels/ch_activation/messages?cursor=fresh-cursor",
    )
    await waitFor(() => snapshots.at(-1)?.ids.includes("m_old") === true)
    expect(snapshots.at(-1)?.ids).toEqual(["m_old", "m_anchor"])
    renderer.unmount()
  })

  it("ignores older pagination while the anchor gate is disabled", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.channelMessages("ch_activation"), {
      pages: [{
        messages: [{ id: "m_cached", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
        hasMore: true,
        cursor: "persisted-cursor",
        latestSeq: 1,
      }],
      pageParams: [{ mode: "newest" }],
    })
    let fetchOlder = () => {}
    const renderer = renderCapture(
      queryClient,
      React.createElement(PaginatingChannelCapture, {
        lastReadMessageId: undefined,
        onRender: (_snapshot, nextFetchOlder) => { fetchOlder = nextFetchOlder },
      }),
    )

    act(() => fetchOlder())
    expect(apiFetchMock).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("queues older pagination behind a generic in-flight refetch", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.channelMessages("ch_activation"), {
      pages: [{
        messages: [{ id: "m_anchor", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" }],
        hasMoreOlder: true,
        hasMoreNewer: false,
        olderCursor: "persisted-cursor",
        latestSeq: 2,
      }],
      pageParams: [{ mode: "anchor", anchor: "m_anchor" }],
    })
    const refetchResponse = deferred<MessagesPage>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("?anchor=m_anchor")) return refetchResponse.promise
      if (url.endsWith("?cursor=fresh-cursor")) {
        return Promise.resolve({
          messages: [{ id: "m_old", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
          hasMoreOlder: false,
          hasMoreNewer: false,
          latestSeq: 2,
        } satisfies MessagesPage)
      }
      throw new Error(`unexpected messages URL: ${url}`)
    })
    const snapshots: Snapshot[] = []
    let refetch = () => Promise.resolve()
    let fetchOlder = () => {}
    const renderer = renderCapture(
      queryClient,
      React.createElement(RefetchingPaginationCapture, {
        onRender: (snapshot, nextRefetch, nextFetchOlder) => {
          snapshots.push(snapshot)
          refetch = nextRefetch
          fetchOlder = nextFetchOlder
        },
      }),
    )

    act(() => { void refetch() })
    await waitFor(() => snapshots.at(-1)?.isFetching === true)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    act(() => fetchOlder())
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    refetchResponse.resolve({
      messages: [{ id: "m_anchor", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" }],
      hasMoreOlder: true,
      hasMoreNewer: false,
      olderCursor: "fresh-cursor",
      latestSeq: 2,
    })
    await waitFor(() => apiFetchMock.mock.calls.length === 2)
    expect(apiFetchMock.mock.calls[1]?.[0]).toBe(
      "/api/community/channels/ch_activation/messages?cursor=fresh-cursor",
    )
    await waitFor(() => snapshots.at(-1)?.ids.includes("m_old") === true)
    expect(snapshots.at(-1)?.ids).toEqual(["m_old", "m_anchor"])
    expect(apiFetchMock.mock.calls.some(
      ([url]) => url.includes("cursor=persisted-cursor"),
    )).toBe(false)
    renderer.unmount()
  })

  it("keeps cold-restore pagination behind a missing-anchor revalidation", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = communityKeys.channelMessages("ch_activation")
    queryClient.setQueryData(key, {
      pages: [{
        messages: [{ id: "m_newest", seq: 3, createdAt: "2026-08-09T00:00:02.000Z" }],
        hasMore: true,
        cursor: "persisted-cursor",
        latestSeq: 3,
      }],
      pageParams: [{ mode: "newest" }],
    })
    const anchorResponse = deferred<MessagesPage>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("?anchor=m_anchor")) return anchorResponse.promise
      if (url.endsWith("?cursor=fresh-cursor")) {
        return Promise.resolve({
          messages: [{ id: "m_old", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
          hasMoreOlder: false,
          hasMoreNewer: false,
          latestSeq: 3,
        } satisfies MessagesPage)
      }
      throw new Error(`unexpected messages URL: ${url}`)
    })
    const snapshots: Snapshot[] = []
    const renderer = renderCapture(
      queryClient,
      React.createElement(LayoutPaginatingChannelCapture, {
        lastReadMessageId: "m_anchor",
        onRender: (snapshot) => { snapshots.push(snapshot) },
      }),
    )

    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(
      "/api/community/channels/ch_activation/messages?anchor=m_anchor",
    )

    anchorResponse.resolve({
      messages: [{ id: "m_anchor", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" }],
      hasMoreOlder: true,
      hasMoreNewer: false,
      olderCursor: "fresh-cursor",
      latestSeq: 3,
    })
    await waitFor(() => apiFetchMock.mock.calls.length === 2)
    expect(apiFetchMock.mock.calls[1]?.[0]).toBe(
      "/api/community/channels/ch_activation/messages?cursor=fresh-cursor",
    )
    await waitFor(() => snapshots.at(-1)?.ids.includes("m_old") === true)
    expect(snapshots.at(-1)?.ids).toEqual(["m_old", "m_anchor"])
    expect(apiFetchMock.mock.calls.some(
      ([url]) => url.includes("cursor=persisted-cursor"),
    )).toBe(false)
    renderer.unmount()
  })

  it("drops queued pagination when the conversation changes during revalidation", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(communityKeys.channelMessages("ch_a"), {
      pages: [{
        messages: [{ id: "m_newest_a", seq: 3, createdAt: "2026-08-09T00:00:02.000Z" }],
        hasMore: true,
        cursor: "persisted-cursor-a",
        latestSeq: 3,
      }],
      pageParams: [{ mode: "newest" }],
    })
    queryClient.setQueryData(communityKeys.channelMessages("ch_b"), {
      pages: [{
        messages: [{ id: "m_anchor_ch_b", seq: 4, createdAt: "2026-08-09T00:00:03.000Z" }],
        hasMoreOlder: false,
        hasMoreNewer: false,
        latestSeq: 4,
      }],
      pageParams: [{ mode: "anchor", anchor: "m_anchor_ch_b" }],
    })
    const anchorResponse = deferred<MessagesPage>()
    apiFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/ch_a/messages?anchor=m_anchor_ch_a")) return anchorResponse.promise
      if (url.endsWith("/ch_b/messages?anchor=m_anchor_ch_b")) {
        return Promise.resolve({
          messages: [{ id: "m_anchor_ch_b", seq: 4, createdAt: "2026-08-09T00:00:03.000Z" }],
          hasMoreOlder: false,
          hasMoreNewer: false,
          latestSeq: 4,
        } satisfies MessagesPage)
      }
      throw new Error(`unexpected messages URL: ${url}`)
    })
    const snapshots: Snapshot[] = []
    const view = (channelId: string, queueOlder: boolean) => React.createElement(
      SwitchingLayoutPaginationCapture,
      {
        channelId,
        queueOlder,
        onRender: (snapshot: Snapshot) => { snapshots.push(snapshot) },
      },
    )
    const renderer = renderCapture(queryClient, view("ch_a", true))

    await waitFor(() => apiFetchMock.mock.calls.length === 1)
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(
      "/api/community/channels/ch_a/messages?anchor=m_anchor_ch_a",
    )
    updateCapture(renderer, queryClient, view("ch_b", false))

    anchorResponse.resolve({
      messages: [{ id: "m_anchor_ch_a", seq: 2, createdAt: "2026-08-09T00:00:01.000Z" }],
      hasMoreOlder: true,
      hasMoreNewer: false,
      olderCursor: "fresh-cursor-a",
      latestSeq: 3,
    })
    await act(async () => { await anchorResponse.promise })
    await act(async () => { await Promise.resolve() })
    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/community/channels/ch_a/messages?anchor=m_anchor_ch_a",
      "/api/community/channels/ch_b/messages?anchor=m_anchor_ch_b",
    ])
    expect(snapshots.at(-1)?.ids).toEqual(["m_anchor_ch_b"])
    renderer.unmount()
  })
})
