import "fake-indexeddb/auto"
import { createElement, type PropsWithChildren } from "react"
import { dehydrate, hydrate, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider, useForumSidebarProjection } from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  ingestServerDetail,
  ingestServers,
  getCanonicalCommunityChannels,
  getCanonicalCommunityMessages,
  projectCommunityWsEventToDb,
  publishCommunityForumSidebar,
  removeCanonicalCommunityChannelMembership,
} from "@/lib/community-db/sync"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"
import {
  deriveForumSidebarProjection,
  grantForumSidebarChild,
  invalidateForumSidebarBaseExact,
  normalizeForumSidebarEnvelope,
  patchForumSidebarActivityExact,
  patchForumSidebarTitleExact,
  reconcileForumSidebarNotifyMemberships,
  reconcileForumSidebarArchiveTag,
  removeForumSidebarThreadExact,
  useForumSidebarThreads,
  type SidebarThreadEnvelope,
} from "./use-forum-sidebar-threads"
import {
  clearPersistedCache,
  createIdbPersister,
  PERSIST_BUSTER,
} from "@/lib/query-persister"

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

const cleanups: Array<() => void | Promise<void>> = []

beforeEach(() => {
  apiFetchMock.mockReset()
  useCommunityWsStore.getState().reset()
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanups.splice(0).map((dispose) => dispose()))
})

function envelope(overrides: Partial<SidebarThreadEnvelope> = {}): SidebarThreadEnvelope {
  const activityAt = new Date(Date.now() - 60_000).toISOString()
  return {
    channels: [{
      id: "post-1",
      name: "fallback",
      parentChannelId: "forum-1",
      parentMessageId: "opener-1",
      activityAt,
      expiresAt: new Date(Date.parse(activityAt) + 72 * 60 * 60 * 1000).toISOString(),
      unread: true,
      serverId: "server-1",
      type: "thread",
      creatorId: "viewer",
      archived: false,
      lastMessageAt: activityAt,
    }],
    included: {
      parentMessages: [{
        id: "opener-1",
        content: "Canonical title",
        seq: 1,
        channelId: "forum-1",
        type: "chat",
      }],
    },
    serverNow: new Date().toISOString(),
    ...overrides,
  }
}

function envelopeFor(ids: string[]): SidebarThreadEnvelope {
  const activityAt = new Date(Date.now() - 60_000).toISOString()
  return envelope({
    channels: ids.map((id) => ({
      id,
      name: `fallback-${id}`,
      parentChannelId: "forum-1",
      parentMessageId: `opener-${id}`,
      activityAt,
      expiresAt: new Date(Date.parse(activityAt) + 72 * 60 * 60 * 1000).toISOString(),
      unread: false,
      serverId: "server-1",
      type: "thread",
      creatorId: "viewer",
      archived: false,
      lastMessageAt: activityAt,
    })),
    included: {
      parentMessages: ids.map((id) => ({
        id: `opener-${id}`,
        content: `title-${id}`,
        channelId: "forum-1",
        type: "chat" as const,
      })),
    },
  })
}

async function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(queryClient, "viewer")
  await registry.preload()
  const unregister = registerCommunityDbRegistry(registry)
  cleanups.push(unregister, registry.cleanup.bind(registry))
  ingestServers(registry, {
    servers: [{
      id: "server-1",
      name: "Server",
      initial: "S",
      active: false,
      unread: false,
      mentions: 0,
      ownerId: "viewer",
    }],
  })
  ingestServerDetail(registry, {
    id: "server-1",
    name: "Server",
    discriminator: "0001",
    description: "",
    icon: null,
    ownerId: "viewer",
    categories: [{
      id: "cat-1",
      name: "Forums",
      channels: [{
        id: "forum-1",
        name: "forum",
        active: false,
        unread: false,
        type: "forum",
      }],
    }],
  })
  const wrapper = ({ children }: PropsWithChildren) => createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(CommunityDbProvider, { registry }, children),
  )
  return { queryClient, registry, wrapper }
}

function publish(queryClient: QueryClient, data = envelope()) {
  const normalized = normalizeForumSidebarEnvelope(data, null)
  publishCommunityForumSidebar(queryClient, {
    serverId: "server-1",
    channels: data.channels,
    openers: data.included.parentMessages,
    proof: {
      token: captureCommunityLiveSnapshotToken(queryClient),
      signal: undefined,
    },
  })
  return normalized
}

describe("forum sidebar canonical projection", () => {
  it("removes only bounded-base misses that could displace the authoritative top five", async () => {
    const { queryClient, registry } = await setup()
    const now = Date.now()
    const stale = envelopeFor(["post-archived", "post-left", "post-retained", "Z-retained"])
    stale.channels[0]!.activityAt = new Date(now - 30_000).toISOString()
    stale.channels[0]!.lastMessageAt = stale.channels[0]!.activityAt
    stale.channels[1]!.activityAt = new Date(now - 40_000).toISOString()
    stale.channels[1]!.lastMessageAt = stale.channels[1]!.activityAt
    stale.channels[2]!.activityAt = new Date(now - 180_000).toISOString()
    stale.channels[2]!.lastMessageAt = stale.channels[2]!.activityAt
    stale.channels[3]!.activityAt = new Date(now - 120_000).toISOString()
    stale.channels[3]!.lastMessageAt = stale.channels[3]!.activityAt
    publish(queryClient, stale)
    const fresh = envelopeFor(["z-fresh", "y-fresh", "x-fresh", "w-fresh", "a-cutoff"])
    for (const channel of fresh.channels) {
      channel.activityAt = new Date(now - 120_000).toISOString()
      channel.lastMessageAt = channel.activityAt
    }
    apiFetchMock.mockResolvedValue({ ...fresh, canonicalChannels: fresh.channels })

    const result = await reconcileForumSidebarNotifyMemberships(queryClient, "server-1")

    expect(apiFetchMock).toHaveBeenCalledOnce()
    expect(result.removedIds).toEqual(["post-archived", "post-left"])
    await waitFor(() => {
      expect(registry.collections.channelMemberships.get("post-archived:viewer:notify"))
        .toBeUndefined()
      expect(registry.collections.channelMemberships.get("post-left:viewer:notify"))
        .toBeUndefined()
    })
    expect(registry.collections.channelMemberships.get("post-retained:viewer:notify"))
      .toBeDefined()
    expect(registry.collections.channelMemberships.get("Z-retained:viewer:notify"))
      .toBeDefined()
    expect(registry.collections.channelMemberships.get("z-fresh:viewer:notify"))
      .toBeDefined()
    expect(registry.collections.channelMemberships.get("post-archived:viewer:access"))
      .toBeDefined()
    expect(registry.collections.channelMemberships.get("post-left:viewer:access"))
      .toBeDefined()
  })

  it("uses one authoritative reconnect fetch with an active base observer", async () => {
    const { queryClient, wrapper } = await setup()
    apiFetchMock.mockResolvedValue(envelope())
    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", null),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true))
    apiFetchMock.mockClear()

    await reconcileForumSidebarNotifyMemberships(queryClient, "server-1")

    expect(apiFetchMock).toHaveBeenCalledOnce()
    rendered.unmount()
  })

  it("keeps warm DB rows visible while the HTTP transport is stalled", async () => {
    const { queryClient, wrapper } = await setup()
    publish(queryClient)
    apiFetchMock.mockReturnValue(new Promise(() => {}))

    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", null),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.threads).toEqual([
      expect.objectContaining({ id: "post-1", title: "Canonical title", unread: true }),
    ]))
    expect(rendered.result.current.projectionReady).toBe(true)
    expect(rendered.result.current.fetchStatus).toBe("fetching")
    rendered.unmount()
    await invalidateForumSidebarBaseExact(queryClient, "server-1")
  })

  it("publishes an HTTP response once and renders later WS edits from the same rows", async () => {
    const { queryClient, wrapper } = await setup()
    apiFetchMock.mockResolvedValue(envelope())
    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", null),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.threads[0]?.title)
      .toBe("Canonical title"))
    act(() => projectCommunityWsEventToDb(queryClient, {
      type: "community:message.edited",
      channelId: "forum-1",
      messageId: "opener-1",
      content: "WS title",
    }))
    await waitFor(() => expect(rendered.result.current.threads[0]?.title).toBe("WS title"))
  })

  it("normalizes a persisted default opener before one successful canonical publish", async () => {
    const { queryClient, wrapper } = await setup()
    const response = envelope()
    response.included.parentMessages[0]!.type = "default" as never
    apiFetchMock.mockResolvedValue(response)
    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", "post-1"),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true))
    expect(apiFetchMock).toHaveBeenCalledOnce()
    expect(getCanonicalCommunityMessages(queryClient)).toContainEqual(
      expect.objectContaining({ id: "opener-1", type: "chat" }),
    )
    rendered.unmount()
  })

  it("stores opener-archive exclusion without archiving the child route", async () => {
    const { queryClient, registry, wrapper } = await setup()
    publish(queryClient)
    const rendered = renderHook(
      () => useForumSidebarProjection("server-1", null, Date.now()),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current?.threads).toHaveLength(1))

    await act(async () => {
      await reconcileForumSidebarArchiveTag(queryClient, "server-1", "post-1", true)
    })
    await waitFor(() => expect(rendered.result.current?.threads).toEqual([]))
    expect(registry.collections.channels.get("post-1")).toMatchObject({ archived: false })
    expect(registry.collections.channelMemberships.get("post-1:viewer:access"))
      .toBeDefined()
    expect(registry.collections.channelMemberships.get("post-1:viewer:notify"))
      .toBeUndefined()

    await act(async () => {
      await reconcileForumSidebarArchiveTag(queryClient, "server-1", "post-1", false)
    })
    await waitFor(() => expect(rendered.result.current?.threads).toHaveLength(1))
    expect(registry.collections.channelMemberships.get("post-1:viewer:notify"))
      .toBeDefined()
  })

  it("keeps only request-clock data in the transport cache under a DB provider", async () => {
    const { queryClient, wrapper } = await setup()
    apiFetchMock.mockResolvedValue(envelope())
    const rendered = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper })

    await waitFor(() => expect(queryClient.getQueryData<{
      threads: unknown[]
      serverNow: string
    }>(communityKeys.forumSidebarThreads("server-1")))
      .toMatchObject({ threads: [], serverNow: expect.any(String) }))
    rendered.unmount()
  })

  it("keeps providerless normalization explicit for pure tests", () => {
    const normalized = normalizeForumSidebarEnvelope(envelope(), null, 0)
    expect(deriveForumSidebarProjection(
      normalized.base,
      null,
      { "forum-1": { baseUnread: false, childIds: ["post-1"] } },
      Date.parse(normalized.base.serverNow),
    )).toEqual({
      threads: [expect.objectContaining({ id: "post-1", unread: true })],
      parentUnread: { "forum-1": false },
    })
  })

  it("preserves system opener types at the canonical ingress boundary", () => {
    const response = envelope()
    response.included.parentMessages[0]!.type = "system"

    expect(normalizeForumSidebarEnvelope(response, null, 0).openerHints["opener-1"])
      .toEqual(expect.objectContaining({ type: "system" }))
  })

  it("expires a canonical row 72h after its latest activity", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-26T00:00:00.000Z"))
    const { queryClient, wrapper } = await setup()
    publish(queryClient, envelopeFor(["post-1"]))
    apiFetchMock.mockReturnValue(new Promise(() => {}))
    const rendered = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper })

    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(rendered.result.current.threads.map(({ id }) => id)).toEqual(["post-1"])
    await act(async () => {
      await vi.advanceTimersByTimeAsync((72 * 60 * 60 * 1000) + 50)
    })
    expect(rendered.result.current.threads).toEqual([])
    rendered.unmount()
    await invalidateForumSidebarBaseExact(queryClient, "server-1")
  })

  it("deduplicates one cold request across a StrictMode-style remount", async () => {
    const { wrapper } = await setup()
    let resolveRequest!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve }))
    const first = renderHook(() => useForumSidebarThreads("server-1", "post-1"), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    first.unmount()
    const second = renderHook(() => useForumSidebarThreads("server-1", "post-1"), { wrapper })
    expect(apiFetchMock).toHaveBeenCalledOnce()
    await act(async () => resolveRequest({
      ...envelopeFor([]),
      canonicalChannels: [],
      retainedChannel: envelopeFor(["post-1"]).channels[0],
      retainedDisposition: "eligible",
      included: envelopeFor(["post-1"]).included,
    }))
    await waitFor(() => expect(second.result.current.threads[0]?.id).toBe("post-1"))
    second.unmount()
  })

  it("restarts a cold request when the retained route candidate changes", async () => {
    const { wrapper } = await setup()
    let resolveSecond!: (value: SidebarThreadEnvelope) => void
    apiFetchMock
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))
    let retainId: string | null = null
    const rendered = renderHook(() => useForumSidebarThreads("server-1", retainId), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    retainId = "post-b"
    rendered.rerender()
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    const retained = envelopeFor(["post-b"])
    await act(async () => resolveSecond({
      ...envelopeFor([]),
      canonicalChannels: [],
      retainedChannel: retained.channels[0],
      retainedDisposition: "eligible",
      included: retained.included,
    }))
    await waitFor(() => expect(rendered.result.current.threads[0]?.id).toBe("post-b"))
    expect(apiFetchMock.mock.calls[1]?.[0]).toContain("retainId=post-b")
    rendered.unmount()
  })

  it("accepts an in-flight response across a transport-only reconnect", async () => {
    const { wrapper } = await setup()
    let resolveRequest!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve }))
    const rendered = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    act(() => {
      useCommunityWsStore.getState().markAccessDisconnected()
      useCommunityWsStore.getState().markAccessConnected()
    })
    await act(async () => resolveRequest(envelopeFor(["post-1"])))
    await waitFor(() => expect(rendered.result.current.threads[0]?.id).toBe("post-1"))
    rendered.unmount()
  })

  it("folds in-flight title, activity, and removal deltas into one canonical publish", async () => {
    const { queryClient, wrapper } = await setup()
    let resolveRequest!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve }))
    const rendered = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    patchForumSidebarTitleExact(queryClient, "server-1", "post-1", "live title")
    patchForumSidebarActivityExact(
      queryClient, "server-1", "post-1", "forum-1", "2026-09-26T10:00:00.000Z",
    )
    removeForumSidebarThreadExact(queryClient, "server-1", "post-2")
    await act(async () => resolveRequest(envelopeFor(["post-1", "post-2"])))
    await waitFor(() => expect(rendered.result.current.threads).toEqual([
      expect.objectContaining({
        id: "post-1",
        title: "live title",
        activityAt: "2026-09-26T10:00:00.000Z",
      }),
    ]))
    expect(getCanonicalCommunityChannels(queryClient).some(({ id }) => id === "post-2"))
      .toBe(false)
    rendered.unmount()
  })

  it("does not let a stale retained response revive an archived row", async () => {
    const { queryClient, wrapper } = await setup()
    let resolveStale!: (value: SidebarThreadEnvelope) => void
    apiFetchMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveStale = resolve }))
      .mockResolvedValueOnce({
        ...envelopeFor([]),
        canonicalChannels: [],
        retainedChannel: null,
        retainedDisposition: "opener-archived",
      })
    const rendered = renderHook(() => useForumSidebarThreads("server-1", "post-1"), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    await act(async () => {
      await reconcileForumSidebarArchiveTag(queryClient, "server-1", "post-1", true)
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    const retained = envelopeFor(["post-1"])
    await act(async () => resolveStale({
      ...envelopeFor([]),
      canonicalChannels: [],
      retainedChannel: retained.channels[0],
      retainedDisposition: "eligible",
      included: retained.included,
    }))
    await act(async () => Promise.resolve())
    expect(getCanonicalCommunityChannels(queryClient).some(({ id }) => id === "post-1"))
      .toBe(false)
    rendered.unmount()
  })

  it("does not revive a row when grant races archive and removal", async () => {
    const { queryClient } = await setup()
    let resolveGrant!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise((resolve) => { resolveGrant = resolve }))
    const grant = grantForumSidebarChild(queryClient, "server-1", "post-1")
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    removeForumSidebarThreadExact(queryClient, "server-1", "post-1")
    await reconcileForumSidebarArchiveTag(queryClient, "server-1", "post-1", true)
    const retained = envelopeFor(["post-1"])
    resolveGrant({
      ...envelopeFor([]),
      canonicalChannels: [],
      retainedChannel: retained.channels[0],
      retainedDisposition: "eligible",
      included: retained.included,
    })
    await grant
    expect(getCanonicalCommunityChannels(queryClient).some(({ id }) => id === "post-1"))
      .toBe(false)
  })

  it("treats a negative retained result as notify evidence, not access revocation", async () => {
    const { queryClient, registry } = await setup()
    publish(queryClient)
    publishCommunityForumSidebar(queryClient, {
      serverId: "server-1",
      channels: [],
      openers: [],
      negativeRetain: { id: "post-1", disposition: "opener-archived" },
      proof: {
        token: captureCommunityLiveSnapshotToken(queryClient),
        signal: undefined,
      },
    })

    expect(registry.collections.channels.get("post-1")).toMatchObject({ archived: false })
    expect(registry.collections.channelMemberships.get("post-1:viewer:access"))
      .toBeDefined()
    expect(registry.collections.channelMemberships.get("post-1:viewer:notify"))
      .toBeUndefined()
  })

  it("clears hidden unread ownership when a canonical refetch removes participation", async () => {
    const { queryClient, registry, wrapper } = await setup()
    publish(queryClient)
    apiFetchMock.mockResolvedValue({
      ...envelopeFor([]),
      canonicalChannels: [],
      retainedChannel: null,
      retainedDisposition: "genuine-negative",
    })
    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", "post-1"),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current).toMatchObject({
      threads: [],
      parentUnread: { "forum-1": false },
    }))
    expect(registry.collections.channels.get("post-1")).toMatchObject({ unread: false })
    expect(registry.collections.channelMemberships.get("post-1:viewer:access"))
      .toBeDefined()
    expect(registry.collections.channelMemberships.get("post-1:viewer:notify"))
      .toBeUndefined()
    rendered.unmount()
  })

  it("keeps cold hidden-child unread ownership in canonical rows", async () => {
    const { registry, wrapper } = await setup()
    ingestServerDetail(registry, {
      id: "server-1", name: "Server", discriminator: "0001", description: "",
      icon: null, ownerId: "viewer", categories: [{
        id: "cat-1", name: "Forums", channels: [{
          id: "forum-1", name: "forum", active: false, unread: false, type: "forum",
        }],
      }],
      forumUnreadState: {
        "forum-1": { baseUnread: false, childIds: ["hidden-child"] },
      },
    })
    const rendered = renderHook(
      () => useForumSidebarProjection("server-1", null, Date.now()),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current).toEqual({
      threads: [],
      parentUnread: { "forum-1": true },
    }))
    expect(registry.collections.channels.get("hidden-child")).toMatchObject({
      type: "thread", parentChannelId: "forum-1", parentMessageId: null, unread: true,
    })
  })

  it("aggregates persisted unread child ownership even without notify membership", async () => {
    const { queryClient, wrapper } = await setup()
    publish(queryClient)
    removeCanonicalCommunityChannelMembership(queryClient, "post-1", "notify")
    const rendered = renderHook(
      () => useForumSidebarProjection("server-1", null, Date.now()),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current).toEqual({
      threads: [],
      parentUnread: { "forum-1": true },
    }))
  })

  it("restores a warm persisted sidebar while HTTP is stalled", async () => {
    await clearPersistedCache("viewer")
    const { queryClient } = await setup()
    publish(queryClient)
    const persister = createIdbPersister("viewer")
    await persister.persistClient({
      timestamp: Date.now(),
      buster: PERSIST_BUSTER,
      clientState: dehydrate(queryClient),
    })
    const restored = await persister.restoreClient()
    expect(restored).toBeDefined()
    const restoredClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    hydrate(restoredClient, restored!.clientState)
    const restoredRegistry = createCommunityDbRegistry(restoredClient, "viewer")
    restoredRegistry.captureRestoredCollections()
    await restoredRegistry.preload()
    const unregister = registerCommunityDbRegistry(restoredRegistry)
    cleanups.push(
      unregister,
      restoredRegistry.cleanup.bind(restoredRegistry),
      () => clearPersistedCache("viewer"),
    )
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: restoredClient },
      createElement(CommunityDbProvider, { registry: restoredRegistry }, children),
    )
    apiFetchMock.mockReturnValue(new Promise(() => {}))
    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", null),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current.threads[0]?.id).toBe("post-1"))
    expect(rendered.result.current.fetchStatus).toBe("fetching")
    rendered.unmount()
    await invalidateForumSidebarBaseExact(restoredClient, "server-1")
  })
})
