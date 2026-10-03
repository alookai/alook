import "fake-indexeddb/auto"
import { createElement, type PropsWithChildren } from "react"
import { dehydrate, hydrate, isCancelledError, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider, useForumSidebarProjection } from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  ingestAttentionSnapshot,
  ingestServerDetail,
  ingestServers,
  getCanonicalCommunityChannels,
  getCanonicalCommunityMessages,
  projectCommunityWsEventToDb,
  publishCommunityForumSidebar,
  removeCanonicalCommunityChannelMembership,
  setCanonicalCommunityChannelMembership,
} from "@/lib/community-db/sync"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useChannelMetadata } from "./use-channel-metadata"
import { useForumOpenerHint } from "./use-forum-opener-hint"
import { isChannelMetadataTokenCurrent } from "./channel-metadata"
import { communityKeys } from "@/lib/query-keys"
import {
  deriveForumSidebarProjection,
  getForumSidebarBase,
  grantForumSidebarChild,
  invalidateForumSidebarBaseExact,
  normalizeForumSidebarEnvelope,
  patchForumSidebarActivityExact,
  patchForumSidebarTitleExact,
  reconcileForumSidebarNotifyMemberships,
  reconcileForumSidebarArchiveTag,
  removeForumSidebarChildrenForParent,
  removeForumSidebarProjectionExact,
  removeForumSidebarThreadExact,
  resolveForumSidebarRouteCandidate,
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

})

beforeEach(() => async () => {
  vi.useRealTimers()
  await act(async () => { await Promise.all(cleanups.splice(0).map((dispose) => dispose())) })
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
  it("hands a fresh sidebar child and opener to the shared qualified route without another GET", async () => {
    const { queryClient, wrapper } = await setup()
    apiFetchMock.mockResolvedValueOnce(envelope())
    let retainId: string | null = null
    const sidebar = renderHook(() => useForumSidebarThreads("server-1", retainId), { wrapper })
    await waitFor(() => expect(sidebar.result.current.threads[0]?.title).toBe("Canonical title"))
    let releaseRetained!: (value: SidebarThreadEnvelope) => void
    const retained = new Promise<SidebarThreadEnvelope>((resolve) => { releaseRetained = resolve })
    apiFetchMock.mockReturnValue(retained)
    retainId = "post-1"
    sidebar.rerender()
    const route = renderHook(() => {
      const metadata = useChannelMetadata("server-1", "post-1")
      const opener = useForumOpenerHint("server-1", metadata.data?.parentMessageId, metadata.isVerified)
      return { metadata, opener }
    }, { wrapper })
    try {
      expect(route.result.current.metadata.isVerified).toBe(true)
      expect(route.result.current.opener.data?.content).toBe("Canonical title")
      await waitFor(() => expect(apiFetchMock.mock.calls.some(([url]) => new URL(url, "http://localhost").searchParams.get("retainId") === "post-1")).toBe(true))
      expect(apiFetchMock.mock.calls.some(([url]) => url === "/api/community/channels/post-1")).toBe(false)
      expect(isChannelMetadataTokenCurrent(queryClient.getQueryData<{ verification: Parameters<typeof isChannelMetadataTokenCurrent>[0] }>(communityKeys.channelMeta("server-1", "post-1"))!.verification)).toBe(true)
    } finally {
      route.unmount()
      sidebar.unmount()
      await act(async () => releaseRetained(envelope()))
      await invalidateForumSidebarBaseExact(queryClient, "server-1")
    }
  })

  it.each(["account", "access"] as const)("cannot qualify a sidebar response from before %s changed", async (race) => {
    const { queryClient } = await setup()
    const token = captureCommunityLiveSnapshotToken(queryClient)
    if (race === "account") getCommunityDbRegistry(queryClient)!.runtime.ws.actions.activateProfileAccount("other")
    else getCommunityDbRegistry(queryClient)!.runtime.ws.actions.revokeChannelAccess("server-1", "post-1")
    expect(() => publishCommunityForumSidebar(queryClient, {
      serverId: "server-1", channels: envelope().channels, openers: envelope().included.parentMessages,
      proof: { token, signal: undefined },
    })).toThrow()
    expect(queryClient.getQueryData(communityKeys.channelMeta("server-1", "post-1"))).toBeUndefined()
    expect(getCanonicalCommunityChannels(queryClient).some(({ id }) => id === "post-1")).toBe(false)
  })

  it("does not qualify an archived child carried in a sidebar response", async () => {
    const { queryClient, registry } = await setup()
    const response = envelope()
    response.channels[0]!.archived = true
    publish(queryClient, response)
    expect(registry.collections.channels.get("post-1")?.archived).toBe(true)
    expect(queryClient.getQueryData(communityKeys.channelMeta("server-1", "post-1"))).toBeUndefined()
  })

  it("classifies retained route candidates and bounded active extras", () => {
    expect(resolveForumSidebarRouteCandidate(null, ["forum-1"], true)).toBeNull()
    expect(resolveForumSidebarRouteCandidate("forum-1", ["forum-1"], true)).toBeNull()
    expect(resolveForumSidebarRouteCandidate("post-3", ["forum-1"], true)).toBe("post-3")

    const base = normalizeForumSidebarEnvelope(envelopeFor(["post-1", "post-2"]), null, 0).base
    const extra = normalizeForumSidebarEnvelope(envelopeFor(["post-3"]), null, 0).base.threads[0]!
    expect(deriveForumSidebarProjection(
      base,
      extra,
      { "forum-1": { baseUnread: false, childIds: ["post-3"] } },
      Date.parse(base.serverNow),
      2,
    )).toMatchObject({
      threads: expect.arrayContaining([expect.objectContaining({ id: "post-3", unread: true })]),
      parentUnread: { "forum-1": false },
    })
  })

  it("ignores incomplete child metadata while normalizing", () => {
    const response = envelope()
    response.channels[0] = { ...response.channels[0]!, serverId: undefined }
    expect(normalizeForumSidebarEnvelope(response, null, 0).channelMetas).toEqual({})
  })

  it("removes only bounded-base misses that could displace the authoritative top five", async () => {
    const { queryClient, registry } = await setup()
    const now = Date.now()
    const stale = envelopeFor([
      "post-archived",
      "post-left",
      "post-retained",
      "Z-retained",
      "post-expired",
      "post-invalid",
    ])
    stale.channels[0]!.activityAt = new Date(now - 30_000).toISOString()
    stale.channels[0]!.lastMessageAt = stale.channels[0]!.activityAt
    stale.channels[1]!.activityAt = new Date(now - 40_000).toISOString()
    stale.channels[1]!.lastMessageAt = stale.channels[1]!.activityAt
    stale.channels[2]!.activityAt = new Date(now - 180_000).toISOString()
    stale.channels[2]!.lastMessageAt = stale.channels[2]!.activityAt
    stale.channels[3]!.activityAt = new Date(now - 120_000).toISOString()
    stale.channels[3]!.lastMessageAt = stale.channels[3]!.activityAt
    stale.channels[4]!.activityAt = new Date(now - (73 * 60 * 60 * 1000)).toISOString()
    stale.channels[4]!.lastMessageAt = stale.channels[4]!.activityAt
    stale.channels[5]!.activityAt = "invalid"
    stale.channels[5]!.lastMessageAt = "invalid"
    publish(queryClient, stale)
    const fresh = envelopeFor(["z-fresh", "y-fresh", "x-fresh", "w-fresh", "a-cutoff"])
    for (const channel of fresh.channels) {
      channel.activityAt = new Date(now - 120_000).toISOString()
      channel.lastMessageAt = channel.activityAt
    }
    apiFetchMock.mockResolvedValue({ ...fresh, canonicalChannels: fresh.channels })

    const result = await reconcileForumSidebarNotifyMemberships(queryClient, "server-1")

    expect(apiFetchMock).toHaveBeenCalledOnce()
    expect(result.removedIds).toEqual(expect.arrayContaining(["post-archived", "post-left"]))
    expect(result.removedIds).not.toContain("post-expired")
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

  it("does not let an older reconnect response delete a newer WS notify membership", async () => {
    const { queryClient, registry } = await setup()
    publish(queryClient, envelopeFor(["post-ws"]))
    act(() => { removeCanonicalCommunityChannelMembership(queryClient, "post-ws", "notify") });
    let settle!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise<SidebarThreadEnvelope>((resolve) => {
      settle = resolve
    }))

    const pending = reconcileForumSidebarNotifyMemberships(queryClient, "server-1")
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    setCanonicalCommunityChannelMembership(
      queryClient,
      "post-ws",
      "notify",
      true,
      { event: true },
    )
    settle(envelopeFor(["post-fresh"]))
    await pending

    expect(registry.collections.channelMemberships.get("post-ws:viewer:notify"))
      .toBeDefined()
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
      expect.objectContaining({ id: "post-1", title: "Canonical title", unread: false }),
    ]))
    expect(rendered.result.current.projectionReady).toBe(true)
    expect(rendered.result.current.fetchStatus).toBe("fetching")
    rendered.unmount()
    await invalidateForumSidebarBaseExact(queryClient, "server-1")
  })

  it("removes a restored notify row displaced by the fresh bounded window", async () => {
    const { queryClient, registry, wrapper } = await setup()
    const restored = envelopeFor([
      "post-6",
      "post-5",
      "post-4",
      "post-3",
      "post-2",
    ])
    publish(queryClient, restored)
    const fresh = envelopeFor([
      "post-5",
      "post-4",
      "post-3",
      "post-2",
      "post-1",
    ])
    for (const channel of fresh.channels) {
      channel.activityAt = restored.channels[0]!.activityAt
      channel.lastMessageAt = channel.activityAt
    }
    apiFetchMock.mockResolvedValue({ ...fresh, canonicalChannels: fresh.channels })

    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", null),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(rendered.result.current.threads.map(({ id }) => id)).toEqual([
      "post-5",
      "post-4",
      "post-3",
      "post-2",
      "post-1",
    ]))
    expect(registry.collections.channelMemberships.get("post-6:viewer:notify"))
      .toBeUndefined()
    expect(registry.collections.channelMemberships.get("post-6:viewer:access"))
      .toBeDefined()
    rendered.unmount()
  })

  it("keeps an unverified cold empty projection pending while HTTP is stalled", async () => {
    const { queryClient, wrapper } = await setup()
    apiFetchMock.mockReturnValue(new Promise(() => {}))

    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", null),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current.fetchStatus).toBe("fetching"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(rendered.result.current.threads).toEqual([])
    expect(rendered.result.current.projectionReady).toBe(false)
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
    const { wrapper, queryClient } = await setup()
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
    const { wrapper, queryClient } = await setup()
    let resolveRequest!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve }))
    const rendered = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    act(() => {
      getCommunityDbRegistry(queryClient)!.runtime.ws.actions.markAccessDisconnected()
      getCommunityDbRegistry(queryClient)!.runtime.ws.actions.markAccessConnected()
    })
    await act(async () => resolveRequest(envelopeFor(["post-1"])))
    await waitFor(() => expect(rendered.result.current.threads[0]?.id).toBe("post-1"))
    rendered.unmount()
  })

  it("folds in-flight title, activity, and removal deltas into one canonical publish", async () => {
    const { queryClient, wrapper } = await setup()
    publish(queryClient, envelopeFor(["post-1", "post-2"]))
    const activityAt = new Date(Date.now() - 60_000).toISOString()
    let resolveRequest!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve }))
    const rendered = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    act(() => { patchForumSidebarTitleExact(queryClient, "server-1", "post-1", "live title") });
    act(() => { patchForumSidebarActivityExact(
      queryClient, "server-1", "post-1", "forum-1", activityAt,
    ) });
    act(() => { patchForumSidebarActivityExact(
      queryClient, "server-1", "missing", "forum-1", activityAt,
    ) });
    act(() => { removeForumSidebarThreadExact(queryClient, "server-1", "post-2") });
    await act(async () => resolveRequest(envelopeFor(["post-1", "post-2"])))
    await waitFor(() => expect(rendered.result.current.threads).toEqual([
      expect.objectContaining({
        id: "post-1",
        title: "live title",
        activityAt,
      }),
    ]))
    expect(getCanonicalCommunityChannels(queryClient).some(({ id }) => id === "post-2"))
      .toBe(false)
    rendered.unmount()
  })

  it("folds an in-flight activity delta into an eligible retained row", async () => {
    const { queryClient, wrapper } = await setup()
    publish(queryClient, envelopeFor(["post-1"]))
    const activityAt = new Date(Date.now() - 60_000).toISOString()
    let resolveRequest!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve }))
    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", "post-1"),
      { wrapper },
    )
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    act(() => { patchForumSidebarActivityExact(
      queryClient, "server-1", "post-1", "forum-1", activityAt,
    ) });
    const retained = envelopeFor(["post-1"])
    await act(async () => resolveRequest({
      ...envelopeFor([]),
      canonicalChannels: [],
      retainedChannel: retained.channels[0],
      retainedDisposition: "eligible",
      included: retained.included,
    }))
    await waitFor(() => expect(rendered.result.current.threads[0]?.activityAt)
      .toBe(activityAt))
    rendered.unmount()
  })

  it("publishes a negative retained response without a matching projected thread", async () => {
    const { wrapper } = await setup()
    const retained = envelopeFor(["post-1"])
    apiFetchMock.mockResolvedValue({
      ...envelopeFor([]),
      canonicalChannels: [],
      retainedChannel: retained.channels[0],
      retainedDisposition: "opener-archived",
      included: retained.included,
    })
    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", "post-1"),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true))
    expect(rendered.result.current.threads).toEqual([])
    rendered.unmount()
  })

  it("aborts an unobserved cold request after the StrictMode grace", async () => {
    vi.useFakeTimers()
    const { wrapper } = await setup()
    let requestSignal: AbortSignal | undefined
    apiFetchMock.mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal
      return new Promise(() => {})
    })
    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", "post-1"),
      { wrapper },
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(apiFetchMock).toHaveBeenCalledOnce()
    rendered.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(51) })
    expect(requestSignal?.aborted).toBe(true)
  })

  it("keeps invalid canonical activity literal and removes children by parent", async () => {
    const { queryClient } = await setup()
    publish(queryClient)
    act(() => { patchForumSidebarTitleExact(queryClient, "server-1", "post-1", "updated title") });
    expect(getCanonicalCommunityMessages(queryClient).find(({ id }) => id === "opener-1")?.content)
      .toBe("updated title")
    act(() => { patchForumSidebarActivityExact(queryClient, "server-1", "post-1", "forum-1", "invalid") });
    expect(getForumSidebarBase(queryClient, "server-1").threads[0]?.expiresAt).toBe("invalid")
    act(() => { removeForumSidebarProjectionExact(queryClient, "server-1", "post-1") });
    act(() => { removeForumSidebarChildrenForParent(queryClient, "server-1", "forum-1") });
    expect(getCanonicalCommunityChannels(queryClient).some(({ id }) => id === "post-1"))
      .toBe(false)
  })

  it("renders the Native canonical transport publication and schedules its next expiry", async () => {
    vi.useFakeTimers()
    const { queryClient, wrapper } = await setup()
    apiFetchMock.mockResolvedValue(envelopeFor(["post-1", "post-2"]))
    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", null),
      { wrapper },
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(rendered.result.current.threads.map(({ id }) => id)).toEqual(["post-2", "post-1"])
    expect(rendered.result.current.projectionReady).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(72 * 60 * 60 * 1000 - 60_000 + 25) })
    expect(rendered.result.current.threads).toEqual([])
    expect(getCanonicalCommunityChannels(queryClient).filter(({ type }) => type === "thread")).toHaveLength(2)
    rendered.unmount()
    queryClient.clear()
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
    const grant = grantForumSidebarChild(queryClient, "server-1", "post-1").catch((error) => error)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    act(() => { removeForumSidebarThreadExact(queryClient, "server-1", "post-1") });
    await reconcileForumSidebarArchiveTag(queryClient, "server-1", "post-1", true)
    const retained = envelopeFor(["post-1"])
    resolveGrant({
      ...envelopeFor([]),
      canonicalChannels: [],
      retainedChannel: retained.channels[0],
      retainedDisposition: "eligible",
      included: retained.included,
    })
    expect(isCancelledError(await grant)).toBe(true)
    expect(getCanonicalCommunityChannels(queryClient).some(({ id }) => id === "post-1"))
      .toBe(false)
  })

  it("clears an in-flight removal delta when an unarchive wins", async () => {
    const { queryClient } = await setup()
    apiFetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise(
      (_resolve, reject) => init.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    ))
    const grant = grantForumSidebarChild(queryClient, "server-1", "post-1")
      .catch(() => undefined)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())

    await reconcileForumSidebarArchiveTag(queryClient, "server-1", "post-1", false)
    await grant
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
      parentUnread: {},
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
    rendered.unmount()
  })

  it("aggregates persisted unread child ownership even without notify membership", async () => {
    const { queryClient, wrapper } = await setup()
    publish(queryClient)
    act(() => { removeCanonicalCommunityChannelMembership(queryClient, "post-1", "notify") });
    const rendered = renderHook(
      () => useForumSidebarProjection("server-1", null, Date.now()),
      { wrapper },
    )
    await waitFor(() => expect(rendered.result.current).toEqual({
      threads: [],
      parentUnread: { "forum-1": true },
    }))
    rendered.unmount()
  })

  it("uses exact scope attention beyond the bounded item window for thread dots", async () => {
    const { queryClient, registry, wrapper } = await setup()
    publish(queryClient)
    ingestAttentionSnapshot(registry, {
      scopes: [{
        scopeId: "post-1",
        channelId: "post-1",
        serverId: "server-1",
        parentChannelId: "forum-1",
        ordinaryUnread: false,
        lastUnreadSeq: 101,
        lastAttentionSeq: 101,
        attentionCount: 101,
      }],
      items: [],
      limit: 100,
      truncated: true,
    })

    const rendered = renderHook(
      () => useForumSidebarThreads("server-1", null),
      { wrapper },
    )

    await waitFor(() => expect(rendered.result.current).toMatchObject({
      threads: [expect.objectContaining({ id: "post-1", unread: true })],
      parentUnread: { "forum-1": true },
    }))
    expect(registry.collections.attentionItems.size).toBe(0)
    rendered.unmount()
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
    const route = renderHook(() => useChannelMetadata("server-1", "post-1"), { wrapper })
    expect(route.result.current.isVerified).toBe(false)
    expect(route.result.current.canonical?.type).toBe("thread")
    route.unmount()
    rendered.unmount()
    await invalidateForumSidebarBaseExact(restoredClient, "server-1")
  })
})
