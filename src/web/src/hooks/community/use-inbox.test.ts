import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import {
  disposeInboxReadReservation,
  inboxChannelRowTarget,
  registerInboxReadReservationSurface,
  takeInboxReadReservationNegative,
} from "./inbox-read-reservation"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useInboxUnreads / inboxUnreadsQueryFn", () => {
  it("fetches /inbox/unreads and populates queryClient at communityKeys.inboxUnreads()", async () => {
    apiFetchMock.mockResolvedValueOnce({ servers: [], dms: [] })
    const { inboxUnreadsQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const key = communityKeys.inboxUnreads()
    await qc.fetchQuery({ queryKey: key, queryFn: inboxUnreadsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/inbox/unreads",
      { signal: expect.any(AbortSignal) },
    )
    expect(qc.getQueryData(key)).toEqual({ servers: [], dms: [] })
  })

  it("aborts an in-flight unread read when the exact query is cancelled", async () => {
    let signal: AbortSignal | undefined
    apiFetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal
      signal.addEventListener("abort", () => reject(new Error("aborted")))
    }))
    const { inboxUnreadsQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const key = communityKeys.inboxUnreads()
    const pending = qc.fetchQuery({ queryKey: key, queryFn: inboxUnreadsQueryFn }).catch(() => undefined)
    await vi.waitFor(() => expect(signal).toBeDefined())
    await qc.cancelQueries({ queryKey: key, exact: true })
    expect(signal?.aborted).toBe(true)
    await pending
  })

  it("fences the production query result until a focused candidate is classified", async () => {
    const data = {
      servers: [{ channels: [{
        channelId: "focused",
        lastMessageAt: "2026-08-27T01:00:00.000Z",
        hasDirectUnread: true,
        children: [],
      }] }],
      dms: [],
    }
    apiFetchMock.mockResolvedValueOnce(data).mockResolvedValueOnce(data)
    const { inboxUnreadsReservedQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const seen = vi.fn()
    const lease = registerInboxReadReservationSurface(qc, "focused", seen)
    const first = inboxUnreadsReservedQueryFn(qc)()
    void first.catch(() => undefined)
    await vi.waitFor(() => expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({
      channelId: "focused",
    })))

    takeInboxReadReservationNegative(lease)
    await expect(first).rejects.toMatchObject({ name: "AbortError" })
    await expect(inboxUnreadsReservedQueryFn(qc)()).resolves.toBe(data)
    disposeInboxReadReservation(qc)
  })

  it("wires the production hook to its live QueryClient across rerenders", async () => {
    apiFetchMock.mockResolvedValue({ servers: [], dms: [] })
    const { useInboxUnreads } = await import("./use-inbox")
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    function Harness() {
      const inbox = useInboxUnreads()
      return React.createElement("span", {
        "data-count": inbox.servers.length + inbox.dms.length,
      })
    }
    const tree = React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Harness),
    )
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(tree)
    })
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    await act(async () => {
      renderer.update(tree)
    })
    expect(renderer.root.findByType("span").props["data-count"]).toBe(0)
    expect(apiFetchMock).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
  })

  it("projects nested channel and DM reads while preserving unchanged rows", async () => {
    const removable = {
      serverId: "s1",
      serverName: "One",
      channels: [{
        channelId: "parent",
        channelName: "Forum",
        lastMessageAt: "2026-08-29T00:00:00.000Z",
        lastUnreadSeq: 2,
        mentionCount: 0,
        hasDirectUnread: true,
        children: [{
          channelId: "child",
          channelName: "Post",
          lastMessageAt: "2026-08-29T00:00:00.000Z",
          lastUnreadSeq: 2,
          mentionCount: 0,
        }],
      }],
    }
    const retained = {
      serverId: "s2",
      serverName: "Two",
      channels: [{
        channelId: "keep",
        channelName: "General",
        lastMessageAt: "2026-08-29T00:00:00.000Z",
        lastUnreadSeq: 3,
        mentionCount: 0,
        hasDirectUnread: true,
        children: [],
      }],
    }
    const removedDm = {
      channelId: "dm-read",
      otherUserId: "u1",
      otherUserName: "One",
      otherUserDiscriminator: "0001",
      otherUserAvatar: "",
      otherUserAvatarVersion: 0,
      lastMessageAt: "2026-08-29T00:00:00.000Z",
      lastUnreadSeq: 2,
    }
    const keptDm = { ...removedDm, channelId: "dm-keep", lastUnreadSeq: 3 }
    const data = { servers: [removable, retained], dms: [removedDm, keptDm], truncated: false }
    apiFetchMock.mockResolvedValue(data)
    const { useInboxUnreads } = await import("./use-inbox")
    const { getActiveAccountUnreadProjection } = await import("./account-unread-projection")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(communityKeys.inboxUnreads(), data)
    const projection = getActiveAccountUnreadProjection(qc)
    projection.recordRead("parent", 2)
    projection.recordRead("child", 2)
    projection.recordRead("dm-read", 2)
    let latest: ReturnType<typeof useInboxUnreads> | undefined
    function Harness() {
      latest = useInboxUnreads()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })

    expect(latest?.servers).toEqual([retained])
    expect(latest?.servers[0]).toBe(retained)
    expect(latest?.dms).toEqual([keptDm])
    expect(latest?.dms[0]).toBe(keptDm)
    expect(latest?.hasProjectedUnread).toBe(true)
    await act(async () => renderer.unmount())
  })

  it("projects one Inbox reservation into the feed aggregate and restores it on rollback", async () => {
    const channel = {
      channelId: "reserved",
      channelName: "Reserved",
      lastMessageAt: "2026-09-02T00:00:00.000Z",
      lastUnreadSeq: 4,
      mentionCount: 0,
      hasDirectUnread: true,
      children: [],
    }
    const server = {
      serverId: "s1",
      serverName: "One",
      channels: [channel],
    }
    const data = { servers: [server], dms: [], truncated: false }
    apiFetchMock.mockResolvedValue(data)
    const { useInboxUnreads } = await import("./use-inbox")
    const { useInboxAutoCollapse } = await import("./use-inbox-auto-collapse")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(communityKeys.inboxUnreads(), data)
    let latest: ReturnType<typeof useInboxUnreads> | undefined
    let collapse: ReturnType<typeof useInboxAutoCollapse> | undefined
    function Harness() {
      latest = useInboxUnreads()
      collapse = useInboxAutoCollapse({
        queryClient: qc,
        publishedHref: "/c/channels/s0",
        navigationPending: false,
        pendingHref: null,
      })
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })
    expect(latest?.hasProjectedUnread).toBe(true)

    let epoch = 0
    await act(async () => {
      epoch = collapse!.beginProjection(
        inboxChannelRowTarget(server, channel)!,
        "/c/channels/s1/reserved",
      )
    })
    expect(latest?.servers).toEqual([])
    expect(latest?.hasProjectedUnread).toBe(false)

    await act(async () => {
      collapse!.rollbackProjection(epoch)
    })
    expect(latest?.servers).toEqual([server])
    expect(latest?.hasProjectedUnread).toBe(true)
    await act(async () => renderer.unmount())
  })

  it("keeps a child-only parent and clones only its changed channel path", async () => {
    const child = {
      channelId: "child",
      channelName: "Post",
      lastMessageAt: "2026-08-29T00:00:00.000Z",
      lastUnreadSeq: 3,
      mentionCount: 0,
    }
    const channel = {
      channelId: "parent",
      channelName: "Forum",
      lastMessageAt: "2026-08-29T00:00:00.000Z",
      lastUnreadSeq: 2,
      mentionCount: 0,
      hasDirectUnread: true,
      children: [child],
    }
    const server = { serverId: "s1", serverName: "One", channels: [channel] }
    const data = { servers: [server], dms: [], truncated: false }
    apiFetchMock.mockResolvedValue(data)
    const { useInboxUnreads } = await import("./use-inbox")
    const { getActiveAccountUnreadProjection } = await import("./account-unread-projection")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(communityKeys.inboxUnreads(), data)
    getActiveAccountUnreadProjection(qc).recordRead("parent", 2)
    let latest: ReturnType<typeof useInboxUnreads> | undefined
    function Harness() {
      latest = useInboxUnreads()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })
    expect(latest?.servers[0]).not.toBe(server)
    expect(latest?.servers[0]?.channels[0]).not.toBe(channel)
    expect(latest?.servers[0]?.channels[0]?.hasDirectUnread).toBe(false)
    expect(latest?.servers[0]?.channels[0]?.children[0]).toBe(child)
    await act(async () => renderer.unmount())
  })

  it("retains legacy unread evidence after an absent rolling-deploy response", async () => {
    const data = {
      servers: [{
        serverId: "s1",
        serverName: "One",
        channels: [{
          channelId: "parent",
          channelName: "Forum",
          lastMessageAt: "2026-08-29T00:00:00.000Z",
          mentionCount: 0,
          hasDirectUnread: true,
          children: [{
            channelId: "child",
            channelName: "Post",
            lastMessageAt: "2026-08-29T00:00:00.000Z",
            mentionCount: 0,
          }],
        }],
      }],
      dms: [{
        channelId: "dm",
        otherUserId: "u1",
        otherUserName: "One",
        otherUserDiscriminator: "0001",
        otherUserAvatar: "",
        otherUserAvatarVersion: 0,
        lastMessageAt: "2026-08-29T00:00:00.000Z",
      }],
    }
    apiFetchMock.mockResolvedValue({ servers: [], dms: [] })
    const { useInboxUnreads } = await import("./use-inbox")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(communityKeys.inboxUnreads(), data)
    let latest: ReturnType<typeof useInboxUnreads> | undefined
    function Harness() {
      latest = useInboxUnreads()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })
    await qc.invalidateQueries({
      queryKey: communityKeys.inboxUnreads(),
      exact: true,
    })
    await vi.waitFor(() => expect(latest?.servers).toEqual([]))
    expect(latest?.servers).toEqual([])
    expect(latest?.dms).toEqual([])
    expect(latest?.hasProjectedUnread).toBe(true)
    await act(async () => renderer.unmount())
  })
})

describe("useInboxMentions / inboxMentionsQueryFn", () => {
  it("fetches /inbox/mentions and populates queryClient at communityKeys.inboxMentions()", async () => {
    apiFetchMock.mockResolvedValueOnce({ mentions: [] })
    const { inboxMentionsQueryFn } = await import("./use-inbox")
    const qc = new QueryClient()
    const key = communityKeys.inboxMentions()
    await qc.fetchQuery({ queryKey: key, queryFn: inboxMentionsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/inbox/mentions")
    expect(qc.getQueryData(key)).toEqual({ mentions: [] })
  })

  it("filters read mentions, preserves unscoped rows, and reports pending arrivals", async () => {
    const scoped = { id: "m1", channelId: "c1", m: { seq: 2 } }
    const unscoped = { id: "m2", m: { seq: 1 } }
    const data = { mentions: [scoped, unscoped], truncated: false }
    apiFetchMock.mockResolvedValue(data)
    const { useInboxMentions } = await import("./use-inbox")
    const { getActiveAccountUnreadProjection } = await import("./account-unread-projection")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(communityKeys.inboxMentions(), data)
    const projection = getActiveAccountUnreadProjection(qc)
    projection.recordRead("c1", 2)
    projection.recordMentionArrival({ channelId: "pending", isMention: true })
    let latest: ReturnType<typeof useInboxMentions> | undefined
    function Harness() {
      latest = useInboxMentions()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })
    expect(latest?.mentions).toEqual([unscoped])
    expect(latest?.mentions[0]).toBe(unscoped)
    expect(latest?.hasProjectedMention).toBe(true)
    await act(async () => renderer.unmount())
  })

  it("returns an empty mention projection before query data arrives", async () => {
    apiFetchMock.mockReturnValue(new Promise(() => undefined))
    const { useInboxMentions } = await import("./use-inbox")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let latest: ReturnType<typeof useInboxMentions> | undefined
    function Harness() {
      latest = useInboxMentions()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })
    expect(latest?.mentions).toEqual([])
    expect(latest?.hasProjectedMention).toBe(false)
    await act(async () => renderer.unmount())
  })

  it("retains a legacy mention after it falls outside a later window", async () => {
    const legacy = {
      id: "legacy",
      channelId: "c1",
      serverId: "s1",
      m: { id: "message" },
    }
    const data = { mentions: [legacy], truncated: true }
    apiFetchMock.mockResolvedValue({ mentions: [], truncated: true })
    const { useInboxMentions } = await import("./use-inbox")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(communityKeys.inboxMentions(), data)
    let latest: ReturnType<typeof useInboxMentions> | undefined
    function Harness() {
      latest = useInboxMentions()
      return null
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })
    await qc.invalidateQueries({
      queryKey: communityKeys.inboxMentions(),
      exact: true,
    })
    await vi.waitFor(() => expect(latest?.mentions).toEqual([]))
    expect(latest?.mentions).toEqual([])
    expect(latest?.hasProjectedMention).toBe(true)
    await act(async () => renderer.unmount())
  })
})

describe("eager Inbox query ownership", () => {
  it("keeps WS-live feeds fresh across observer remounts without duplicate reads", async () => {
    apiFetchMock.mockImplementation((url: string) => Promise.resolve(
      url.endsWith("/unreads")
        ? { servers: [], dms: [] }
        : { mentions: [] },
    ))
    const { useInboxMentions, useInboxUnreads } = await import("./use-inbox")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Harness() {
      useInboxUnreads()
      useInboxMentions()
      return null
    }
    const tree = React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(Harness),
    )
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(tree)
    })
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    await act(async () => renderer.unmount())
    await act(async () => {
      renderer = TestRenderer.create(tree)
    })

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    for (const queryKey of [
      communityKeys.inboxUnreads(),
      communityKeys.inboxMentions(),
    ]) {
      const options = qc.getQueryCache().find({ queryKey })?.options
      expect(options?.staleTime).toBe(Infinity)
      expect(options?.refetchOnReconnect).toBe(true)
    }
    await qc.invalidateQueries({ queryKey: communityKeys.inbox() })
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(4))
    await act(async () => renderer.unmount())
  })
})

describe("useInboxMarked", () => {
  it("fetches the identity-aware marked feed only when enabled", async () => {
    apiFetchMock.mockResolvedValue({ marked: [] })
    const { useInboxMarked } = await import("./use-inbox")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Harness() {
      const result = useInboxMarked(true)
      return React.createElement("span", { "data-count": result.marked.length })
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })

    await vi.waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/marks")
    })
    expect(renderer.root.findByType("span").props["data-count"]).toBe(0)
    act(() => renderer.unmount())
  })
})

// WS reconciliation invalidates the shared `inbox()` prefix — both feeds must
// pick it up, otherwise mentions or unread refreshes would silently drop.
describe("communityKeys.inbox() prefix invalidation", () => {
  it("invalidates both inbox queries in a single call", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ servers: [], dms: [] })
      .mockResolvedValueOnce({ mentions: [] })
    const { inboxUnreadsQueryFn, inboxMentionsQueryFn } = await import(
      "./use-inbox"
    )
    const qc = new QueryClient()
    const unreadsKey = communityKeys.inboxUnreads()
    const mentionsKey = communityKeys.inboxMentions()
    await qc.fetchQuery({ queryKey: unreadsKey, queryFn: inboxUnreadsQueryFn })
    await qc.fetchQuery({ queryKey: mentionsKey, queryFn: inboxMentionsQueryFn })

    await qc.invalidateQueries({ queryKey: communityKeys.inbox() })

    expect(qc.getQueryState(unreadsKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(mentionsKey)?.isInvalidated).toBe(true)
  })
})
