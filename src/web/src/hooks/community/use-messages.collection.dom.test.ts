// @vitest-environment jsdom
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { apiFetch } from "@/lib/api/client"
import {
  createCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import { CommunityDbProvider, useCanonicalMessagesById } from "@/lib/community-db/projections"
import type { MessagesPage, Msg } from "@/lib/community/models/message"
import {
  settleMessageWindowPresentRequest,
  useDmMessages,
  useMessages,
} from "./use-messages"

vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn() }))

const apiFetchMock = vi.mocked(apiFetch)
const cleanups: Array<() => Promise<void>> = []

function ancillaryResponse(url: string) {
  if (url === "/api/community/users/me/read-state") {
    return { revision: 0, readStates: [] }
  }
  if (url === "/api/community/users/me/attention") {
    return {
      scopes: [], items: [], limit: 100, truncated: false,
      included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
    }
  }
  if (url === "/api/community/users/me/dms") return { conversations: [] }
  if (url === "/api/community/users/me/server-folders") return { folders: [] }
  if (url === "/api/community/users/me/notifications") return []
  throw new Error(`unexpected ancillary request: ${url}`)
}

function messageRequests() {
  return apiFetchMock.mock.calls.filter(([url]) => String(url).includes("/messages"))
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dispose) => dispose()))
  apiFetchMock.mockReset()
})

const message = (seq: number): Msg => ({
  id: `m${seq}`,
  type: "chat",
  seq,
  createdAt: new Date(seq * 1000).toISOString(),
  content: `message ${seq}`,
})

async function runtime() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const registry = createCommunityDbRegistry(queryClient, "viewer")
  await registry.ensureCollectionReady("messages")
  const disposeRegistry = registry.cleanup.bind(registry)
  cleanups.push(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
    await disposeRegistry()
    queryClient.clear()
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => React.createElement(
    QueryClientProvider,
    { client: queryClient },
    React.createElement(CommunityDbProvider, { registry }, children),
  )
  return { queryClient, registry, wrapper }
}

describe("message collection leaf readiness", () => {
  it.each([
    [0, []],
    [1, ["m1"]],
    [30, Array.from({ length: 30 }, (_, index) => `m${index + 1}`)],
  ] as const)("settles a direct channel with %i messages without Inbox activation", async (count, ids) => {
    apiFetchMock.mockImplementation(async (url) => {
      const href = String(url)
      return href.includes("/messages") ? {
        messages: Array.from({ length: count }, (_, index) => message(index + 1)),
        hasMore: false,
        latestSeq: count,
      } : ancillaryResponse(href)
    })
    const { wrapper } = await runtime()
    const rendered = renderHook(
      () => useMessages("channel", {
        serverId: "server",
        lastReadMessageId: null,
        viewerUserId: "viewer",
      }),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.isPending).toBe(false))

    expect(rendered.result.current.isLoading).toBe(false)
    expect(rendered.result.current.messages.map((row) => row.id)).toEqual(ids)
    expect(messageRequests()).toHaveLength(1)
    expect(messageRequests()[0]?.[0]).toBe(
      "/api/community/channels/channel/messages",
    )
    await act(async () => {
      rendered.unmount()
      await Promise.resolve()
    })
  })

  it("grows older history through the pager and keeps the settled leaf independent of a later global reader", async () => {
    let releaseOlder!: (page: MessagesPage) => void
    apiFetchMock.mockImplementation(async (url) => {
      const href = String(url)
      if (!href.includes("/messages")) return ancillaryResponse(href)
      return href.includes("cursor=older-50")
        ? new Promise((resolve) => { releaseOlder = resolve })
        : {
            messages: Array.from({ length: 50 }, (_, index) => message(index + 26)),
            hasMore: true,
            cursor: "older-50",
            latestSeq: 75,
          }
    })
    const { registry, wrapper } = await runtime()
    const leaf = renderHook(
      () => useMessages("channel", {
        serverId: "server",
        lastReadMessageId: null,
        viewerUserId: "viewer",
      }),
      { wrapper },
    )
    await waitFor(() => expect(leaf.result.current.messages).toHaveLength(50))
    expect(leaf.result.current.hasMoreOlder).toBe(true)
    expect(messageRequests()).toHaveLength(1)

    act(() => leaf.result.current.fetchOlder())
    await waitFor(() => expect(messageRequests()).toHaveLength(2))
    await act(async () => {
      releaseOlder({
        messages: Array.from({ length: 25 }, (_, index) => message(index + 1)),
        hasMore: false,
        latestSeq: 75,
      })
    })
    await waitFor(() => {
      expect(leaf.result.current.messages).toHaveLength(75)
      expect(registry.collections.messages.size).toBe(75)
    })
    expect(leaf.result.current.hasMoreOlder).toBe(false)

    const inboxLikeReader = renderHook(() => useCanonicalMessagesById(), { wrapper })
    await waitFor(() => expect(inboxLikeReader.result.current?.size).toBe(75))
    expect(leaf.result.current.messages).toHaveLength(75)
    expect(messageRequests().map(([url]) => String(url))).toEqual([
      "/api/community/channels/channel/messages",
      "/api/community/channels/channel/messages?cursor=older-50",
    ])
    await act(async () => {
      inboxLikeReader.unmount()
      leaf.unmount()
      await Promise.resolve()
    })
  })

  it("keeps a cold leaf pending until its anchor decision resolves, then self-activates", async () => {
    apiFetchMock.mockImplementation(async (url) => {
      const href = String(url)
      return href.includes("/messages")
        ? { messages: [message(1)], hasMore: false, latestSeq: 1 }
        : ancillaryResponse(href)
    })
    const { wrapper } = await runtime()
    const rendered = renderHook(
      ({ lastReadMessageId }: { lastReadMessageId: string | null | undefined }) => (
        useMessages("channel", {
          serverId: "server",
          lastReadMessageId,
          viewerUserId: "viewer",
        })
      ),
      { initialProps: { lastReadMessageId: undefined }, wrapper },
    )

    expect(rendered.result.current.isLoading).toBe(true)
    expect(apiFetchMock).not.toHaveBeenCalled()
    act(() => rendered.rerender({ lastReadMessageId: null }))
    await waitFor(() => expect(rendered.result.current.isPending).toBe(false))
    expect(rendered.result.current.messages.map((row) => row.id)).toEqual(["m1"])
    await act(async () => {
      rendered.unmount()
      await Promise.resolve()
    })
  })

  it("projects only the active anchor window from the canonical superset", async () => {
    apiFetchMock.mockImplementation(async (url) => {
      const href = String(url)
      return href.includes("/messages")
        ? {
            messages: [message(2), message(3), message(4)],
            hasMoreOlder: false,
            hasMoreNewer: false,
            latestSeq: 4,
          }
        : ancillaryResponse(href)
    })
    const { registry, wrapper } = await runtime()
    const rendered = renderHook(
      () => useMessages("channel", {
        serverId: "server",
        lastReadMessageId: "m3",
        viewerUserId: "viewer",
      }),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.messages.map((row) => row.id))
      .toEqual(["m2", "m3", "m4"]))
    act(() => registry.collections.messages.utils.writeUpsert({
      ...message(99),
      channelId: "channel",
    }))
    await waitFor(() => expect(rendered.result.current.messages.map((row) => row.id))
      .toEqual(["m2", "m3", "m4"]))
    expect(rendered.result.current.messages.some((row) => row.id === "m99")).toBe(false)
    await act(async () => {
      rendered.unmount()
      await Promise.resolve()
    })
  })

  it("jumps from an anchor to one canonical tail owner and advances presentVersion", async () => {
    apiFetchMock.mockImplementation(async (url) => {
      const href = String(url)
      if (!href.includes("/messages")) return ancillaryResponse(href)
      return href.includes("anchor=m3")
        ? {
            messages: [message(2), message(3), message(4)],
            hasMoreOlder: false,
            hasMoreNewer: false,
            latestSeq: 4,
          }
        : {
            messages: [message(10), message(11)],
            hasMore: false,
            latestSeq: 11,
          }
    })
    const { queryClient, wrapper } = await runtime()
    const rendered = renderHook(
      () => useMessages("channel", {
        serverId: "server",
        lastReadMessageId: "m3",
        viewerUserId: "viewer",
      }),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current.messages.map((row) => row.id))
      .toEqual(["m2", "m3", "m4"]))

    act(() => rendered.result.current.jumpToPresent())

    await waitFor(() => expect(rendered.result.current.presentVersion).toBe(1))
    expect(rendered.result.current.messages.map((row) => row.id)).toEqual(["m10", "m11"])
    expect(messageRequests().filter(([url]) => !String(url).includes("anchor=")))
      .toHaveLength(1)
    await act(async () => {
      rendered.unmount()
      await Promise.resolve()
    })
  })

  it("grows the newer side of an anchored window", async () => {
    apiFetchMock.mockImplementation(async (url) => {
      const href = String(url)
      if (!href.includes("/messages")) return ancillaryResponse(href)
      if (href.includes("since=newer-26")) {
        return { messages: [message(39)], hasMoreNewer: false, latestSeq: 39 }
      }
      return {
        messages: Array.from({ length: 26 }, (_, index) => message(index + 13)),
        hasMoreOlder: false,
        hasMoreNewer: true,
        newerCursor: "newer-26",
        latestSeq: 38,
      }
    })
    const { wrapper } = await runtime()
    const rendered = renderHook(
      () => useMessages("channel", {
        serverId: "server",
        lastReadMessageId: "m13",
        viewerUserId: "viewer",
      }),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current.hasMoreNewer).toBe(true))

    act(() => rendered.result.current.fetchNewer())

    await waitFor(() => expect(rendered.result.current.messages.some(({ id }) => id === "m39"))
      .toBe(true))
    expect(messageRequests().some(([url]) => String(url).includes("since=newer-26"))).toBe(true)
    await act(async () => {
      rendered.unmount()
      await Promise.resolve()
    })
  })

  it("resets a settled tail through the canonical message resource", async () => {
    apiFetchMock.mockImplementation(async (url) => {
      const href = String(url)
      return href.includes("/messages")
        ? { messages: [message(1)], hasMore: false, latestSeq: 1 }
        : ancillaryResponse(href)
    })
    const { wrapper } = await runtime()
    const rendered = renderHook(
      () => useMessages("channel", {
        serverId: "server",
        lastReadMessageId: null,
        viewerUserId: "viewer",
      }),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current.isPending).toBe(false))

    await act(async () => rendered.result.current.refetch())

    await waitFor(() => expect(messageRequests()).toHaveLength(2))
    expect(rendered.result.current.messages.map(({ id }) => id)).toEqual(["m1"])
    await act(async () => {
      rendered.unmount()
      await Promise.resolve()
    })
  })

  it("keeps stale newer and present callbacks scoped to their original identity", async () => {
    apiFetchMock.mockImplementation(async (url) => {
      const href = String(url)
      if (!href.includes("/messages")) return ancillaryResponse(href)
      if (href.includes("channel-a")) {
        return {
          messages: Array.from({ length: 26 }, (_, index) => message(index + 13)),
          hasMoreOlder: false,
          hasMoreNewer: true,
          newerCursor: "newer",
          latestSeq: 38,
        }
      }
      return { messages: [message(2)], hasMore: false, latestSeq: 2 }
    })
    const { wrapper } = await runtime()
    const rendered = renderHook(
      ({ channelId }) => useMessages(channelId, {
        serverId: "server",
        lastReadMessageId: channelId === "channel-a" ? "m13" : null,
        viewerUserId: "viewer",
      }),
      { initialProps: { channelId: "channel-a" }, wrapper },
    )
    await waitFor(() => expect(rendered.result.current.hasMoreNewer).toBe(true))
    const staleFetchNewer = rendered.result.current.fetchNewer
    const staleJumpToPresent = rendered.result.current.jumpToPresent
    rendered.rerender({ channelId: "channel-b" })
    await waitFor(() => expect(rendered.result.current.messages.map(({ id }) => id)).toEqual(["m2"]))

    act(() => staleJumpToPresent())
    await waitFor(() => expect(rendered.result.current.messages.map(({ id }) => id)).toEqual(["m2"]))
    act(() => staleFetchNewer())

    await waitFor(() => expect(rendered.result.current.messages.map(({ id }) => id)).toEqual(["m2"]))
    await act(async () => {
      rendered.unmount()
      await Promise.resolve()
    })
  })

  it("settles only the present request owned by the active identity", () => {
    const pending = {
      key: "channel-a",
      newerLimit: 0,
      olderLimit: 50,
      presentRequested: true,
      presentVersion: 4,
      tail: true,
    }
    expect(settleMessageWindowPresentRequest(pending, "channel-b")).toBe(pending)
    expect(settleMessageWindowPresentRequest({
      ...pending,
      presentRequested: false,
    }, "channel-a")).toEqual({
      ...pending,
      presentRequested: false,
    })
    expect(settleMessageWindowPresentRequest(pending, "channel-a")).toEqual({
      ...pending,
      presentRequested: false,
      presentVersion: 5,
    })
  })

  it("keeps a stale older callback scoped to its original identity", async () => {
    apiFetchMock.mockImplementation(async (url) => {
      const href = String(url)
      if (!href.includes("/messages")) return ancillaryResponse(href)
      return href.includes("channel-a")
        ? { messages: [message(1)], hasMore: true, cursor: "older", latestSeq: 1 }
        : { messages: [message(2)], hasMore: false, latestSeq: 2 }
    })
    const { wrapper } = await runtime()
    const rendered = renderHook(
      ({ channelId }) => useMessages(channelId, {
        serverId: "server",
        lastReadMessageId: null,
        viewerUserId: "viewer",
      }),
      { initialProps: { channelId: "channel-a" }, wrapper },
    )
    await waitFor(() => expect(rendered.result.current.hasMoreOlder).toBe(true))
    const staleFetchOlder = rendered.result.current.fetchOlder
    rendered.rerender({ channelId: "channel-b" })
    await waitFor(() => expect(rendered.result.current.messages.map(({ id }) => id)).toEqual(["m2"]))

    act(() => staleFetchOlder())

    await waitFor(() => expect(rendered.result.current.messages.map(({ id }) => id)).toEqual(["m2"]))
    await act(async () => {
      rendered.unmount()
      await Promise.resolve()
    })
  })

  it("uses the default DM options for a null scope without starting transport", async () => {
    const { wrapper } = await runtime()
    const rendered = renderHook(() => useDmMessages(null), { wrapper })
    expect(rendered.result.current.messages).toEqual([])
    expect(messageRequests()).toHaveLength(0)
    await act(async () => {
      rendered.unmount()
      await Promise.resolve()
    })
  })
})
