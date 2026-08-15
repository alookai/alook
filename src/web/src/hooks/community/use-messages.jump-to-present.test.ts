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

type Snapshot = {
  hasMoreNewer: boolean
  ids: string[]
  isFetchingNewer: boolean
  jumpToPresent: () => void
}

function ChannelCapture({
  anchorMessageId,
  channelId,
  lastReadMessageId,
  onRender,
}: {
  anchorMessageId?: string | null
  channelId: string
  lastReadMessageId: string | null
  onRender: (snapshot: Snapshot) => void
}) {
  const result = useMessages(channelId, {
    anchorMessageId,
    lastReadMessageId,
    serverId: "server_1",
  })
  onRender({
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetchingNewer: result.isFetchingNewer,
    jumpToPresent: result.jumpToPresent,
  })
  return null
}

function DmCapture({
  dmId,
  lastReadMessageId,
  onRender,
}: {
  dmId: string
  lastReadMessageId: string | null
  onRender: (snapshot: Snapshot) => void
}) {
  const result = useDmMessages(dmId, { lastReadMessageId })
  onRender({
    hasMoreNewer: result.hasMoreNewer,
    ids: result.messages.map((message) => message.id),
    isFetchingNewer: result.isFetchingNewer,
    jumpToPresent: result.jumpToPresent,
  })
  return null
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnMount: false,
        retry: false,
      },
    },
  })
}

function seedAnchor(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  anchorId: string,
): void {
  queryClient.setQueryData(queryKey, {
    pages: [{
      messages: [{ id: anchorId, seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
      hasMoreOlder: false,
      hasMoreNewer: true,
      newerCursor: anchorId,
      latestSeq: 36,
    }],
    pageParams: [{ mode: "anchor", anchor: anchorId }],
  })
}

function newestPage(id: string): MessagesPage {
  return {
    messages: [{ id, seq: 36, createdAt: "2026-08-09T00:01:00.000Z" }],
    hasMore: false,
    latestSeq: 36,
  }
}

function render(
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

function update(
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

async function waitFor(predicate: () => boolean, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
  expect(predicate()).toBe(true)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  apiFetchMock.mockReset()
  useMessageStreamStore.getState().resetAll()
})

describe("useMessages jumpToPresent", () => {
  it("resets once, fetches newest once, and keeps the old last-read anchor suppressed", async () => {
    const queryClient = createClient()
    const queryKey = communityKeys.channelMessages("channel_1")
    seedAnchor(queryClient, queryKey, "anchor_1")
    apiFetchMock.mockResolvedValue(newestPage("latest_1"))
    const resetSpy = vi.spyOn(queryClient, "resetQueries")
    let latest!: Snapshot
    const onRender = (snapshot: Snapshot) => { latest = snapshot }
    const renderer = render(
      queryClient,
      React.createElement(ChannelCapture, {
        channelId: "channel_1",
        lastReadMessageId: "anchor_1",
        onRender,
      }),
    )

    act(() => latest.jumpToPresent())
    await waitFor(() => latest.ids[0] === "latest_1" && !latest.isFetchingNewer)

    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(resetSpy).toHaveBeenCalledWith({ queryKey, exact: true })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/channel_1/messages",
      { signal: expect.any(AbortSignal) },
    )
    expect(latest.hasMoreNewer).toBe(false)

    act(() => latest.jumpToPresent())
    await act(async () => { await Promise.resolve() })
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    update(
      renderer,
      queryClient,
      React.createElement(ChannelCapture, {
        channelId: "channel_1",
        lastReadMessageId: "stale_anchor_update",
        onRender,
      }),
    )
    await waitFor(() => latest.ids[0] === "latest_1")
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    renderer.unmount()
  })

  it("treats repeated clicks during one pending attempt as idempotent", async () => {
    const queryClient = createClient()
    const queryKey = communityKeys.channelMessages("channel_pending")
    seedAnchor(queryClient, queryKey, "anchor_pending")
    const response = deferred<MessagesPage>()
    apiFetchMock.mockReturnValue(response.promise)
    const resetSpy = vi.spyOn(queryClient, "resetQueries")
    let latest!: Snapshot
    const renderer = render(
      queryClient,
      React.createElement(ChannelCapture, {
        channelId: "channel_pending",
        lastReadMessageId: "anchor_pending",
        onRender: (snapshot) => { latest = snapshot },
      }),
    )

    act(() => latest.jumpToPresent())
    await waitFor(() => latest.isFetchingNewer && apiFetchMock.mock.calls.length === 1)
    act(() => latest.jumpToPresent())
    await act(async () => { await Promise.resolve() })
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    response.resolve(newestPage("latest_pending"))
    await waitFor(() => latest.ids[0] === "latest_pending" && !latest.isFetchingNewer)
    renderer.unmount()
  })

  it("clears the override across A to B to A navigation", async () => {
    const queryClient = createClient()
    seedAnchor(queryClient, communityKeys.channelMessages("channel_a"), "anchor_a")
    seedAnchor(queryClient, communityKeys.channelMessages("channel_b"), "anchor_b")
    apiFetchMock.mockImplementation((url: string) => {
      if (url === "/api/community/channels/channel_a/messages") {
        return Promise.resolve(newestPage("latest_a"))
      }
      if (url === "/api/community/channels/channel_a/messages?anchor=anchor_a") {
        return Promise.resolve({
          messages: [{ id: "anchor_a", seq: 1, createdAt: "2026-08-09T00:00:00.000Z" }],
          hasMoreOlder: false,
          hasMoreNewer: true,
          newerCursor: "anchor_a",
          latestSeq: 36,
        } satisfies MessagesPage)
      }
      throw new Error(`unexpected URL: ${url}`)
    })
    let latest!: Snapshot
    const onRender = (snapshot: Snapshot) => { latest = snapshot }
    const renderer = render(
      queryClient,
      React.createElement(ChannelCapture, {
        channelId: "channel_a",
        lastReadMessageId: "anchor_a",
        onRender,
      }),
    )

    act(() => latest.jumpToPresent())
    await waitFor(() => latest.ids[0] === "latest_a")
    update(
      renderer,
      queryClient,
      React.createElement(ChannelCapture, {
        channelId: "channel_b",
        lastReadMessageId: "anchor_b",
        onRender,
      }),
    )
    await waitFor(() => latest.ids[0] === "anchor_b")
    update(
      renderer,
      queryClient,
      React.createElement(ChannelCapture, {
        channelId: "channel_a",
        lastReadMessageId: "anchor_a",
        onRender,
      }),
    )
    await waitFor(() => apiFetchMock.mock.calls.some(
      ([url]) => url === "/api/community/channels/channel_a/messages?anchor=anchor_a",
    ))
    await waitFor(() => latest.ids[0] === "anchor_a")
    expect(apiFetchMock.mock.calls.filter(
      ([url]) => url === "/api/community/channels/channel_a/messages",
    )).toHaveLength(1)
    renderer.unmount()
  })

  it("re-arms when the explicit jump target changes", async () => {
    const queryClient = createClient()
    const queryKey = communityKeys.channelMessages("channel_target")
    seedAnchor(queryClient, queryKey, "target_a")
    apiFetchMock.mockImplementation((url: string) => {
      if (url === "/api/community/channels/channel_target/messages") {
        return Promise.resolve(newestPage("latest_target"))
      }
      if (url === "/api/community/channels/channel_target/messages?anchor=target_b") {
        return Promise.resolve({
          messages: [{ id: "target_b", seq: 20, createdAt: "2026-08-09T00:00:30.000Z" }],
          hasMoreOlder: true,
          hasMoreNewer: true,
          newerCursor: "target_b",
          latestSeq: 36,
        } satisfies MessagesPage)
      }
      throw new Error(`unexpected URL: ${url}`)
    })
    let latest!: Snapshot
    const onRender = (snapshot: Snapshot) => { latest = snapshot }
    const renderer = render(
      queryClient,
      React.createElement(ChannelCapture, {
        anchorMessageId: "target_a",
        channelId: "channel_target",
        lastReadMessageId: "read_anchor",
        onRender,
      }),
    )

    act(() => latest.jumpToPresent())
    await waitFor(() => latest.ids[0] === "latest_target")
    update(
      renderer,
      queryClient,
      React.createElement(ChannelCapture, {
        anchorMessageId: "target_b",
        channelId: "channel_target",
        lastReadMessageId: "read_anchor",
        onRender,
      }),
    )
    await waitFor(() => latest.ids[0] === "target_b")
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/channel_target/messages?anchor=target_b",
    )
    renderer.unmount()
  })

  it("restores the anchored window after failure and lets the user retry", async () => {
    const queryClient = createClient()
    const queryKey = communityKeys.channelMessages("channel_retry")
    seedAnchor(queryClient, queryKey, "anchor_retry")
    apiFetchMock
      .mockRejectedValueOnce(new Error("newest failed"))
      .mockResolvedValueOnce(newestPage("latest_retry"))
    const resetSpy = vi.spyOn(queryClient, "resetQueries")
    let latest!: Snapshot
    const renderer = render(
      queryClient,
      React.createElement(ChannelCapture, {
        channelId: "channel_retry",
        lastReadMessageId: "anchor_retry",
        onRender: (snapshot) => { latest = snapshot },
      }),
    )

    act(() => latest.jumpToPresent())
    await waitFor(() => latest.ids[0] === "anchor_retry" && !latest.isFetchingNewer)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    act(() => latest.jumpToPresent())
    await waitFor(() => latest.ids[0] === "latest_retry" && !latest.isFetchingNewer)
    expect(resetSpy).toHaveBeenCalledTimes(2)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    renderer.unmount()
  })
})

describe("useDmMessages jumpToPresent", () => {
  it("uses the same one-reset present override for DMs", async () => {
    const queryClient = createClient()
    const queryKey = communityKeys.dmMessages("dm_1")
    seedAnchor(queryClient, queryKey, "dm_anchor")
    apiFetchMock.mockResolvedValue(newestPage("dm_latest"))
    const resetSpy = vi.spyOn(queryClient, "resetQueries")
    let latest!: Snapshot
    const onRender = (snapshot: Snapshot) => { latest = snapshot }
    const renderer = render(
      queryClient,
      React.createElement(DmCapture, {
        dmId: "dm_1",
        lastReadMessageId: "dm_anchor",
        onRender,
      }),
    )

    act(() => latest.jumpToPresent())
    await waitFor(() => latest.ids[0] === "dm_latest" && !latest.isFetchingNewer)
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(resetSpy).toHaveBeenCalledWith({ queryKey, exact: true })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/channels/dm_1/messages",
      { signal: expect.any(AbortSignal) },
    )

    update(
      renderer,
      queryClient,
      React.createElement(DmCapture, {
        dmId: "dm_1",
        lastReadMessageId: "dm_old_update",
        onRender,
      }),
    )
    await waitFor(() => latest.ids[0] === "dm_latest")
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    renderer.unmount()
  })
})
