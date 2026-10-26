import { conversationEntryFromChannel } from "@/test/conversation-entry-fixtures"
import { conversationEntryOptions } from "@/lib/community/conversation-entry"
import "fake-indexeddb/auto"
import { createElement, useLayoutEffect, type PropsWithChildren } from "react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { dehydrate, hydrate, CancelledError, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, registerCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider, useForumSidebarProjection, useServerTreeProjection } from "@/lib/community-db/projections"
import { ChannelSidebarRevealBoundary } from "@/components/community/channels/channel-sidebar-tree-owner"
import { tid } from "@/lib/community/testids"
import {
  captureCommunityLiveSnapshotToken,
  ingestAttentionSnapshot,
  ingestMessages,
  ingestServerDetail,
  ingestServers,
  getCanonicalCommunityChannels,
  getCanonicalCommunityChannelMemberships,
  getCanonicalCommunityMessages,
  projectCommunityWsEventToDb,
  publishCommunityLiveSnapshot,
  purgeCommunityChannel,
  publishCommunityForumSidebar,
  publishCommunityChannelMetadata,
  removeCanonicalCommunityChannelMembership,
  setCanonicalCommunityChannelMembership,
} from "@/lib/community-db/sync"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useChannelMetadata } from "./use-channel-metadata"
import { projectForumSidebar } from "@/lib/community/forum-sidebar"
import { useForumOpenerHint } from "./use-forum-opener-hint"
import { isChannelMetadataTokenCurrent } from "./channel-metadata"
import { communityKeys } from "@/lib/query-keys"
import {
  getForumSidebarBase,
  grantForumSidebarChild,
  invalidateForumSidebarBaseExact,
  normalizeForumSidebarEnvelope,
  patchForumSidebarActivityExact,
  patchForumSidebarTitleExact,
  reconcileForumSidebarNotifyMemberships,
  reconcileForumSidebarArchiveTag,
  removeForumSidebarProjectionExact,
  resolveForumSidebarRouteCandidate,
  useForumSidebarThreads,
  type SidebarThreadEnvelope,
} from "./use-forum-sidebar-threads"
import { readCommunityRestoredCollections,
  clearPersistedCache,
  createIdbPersister,
  PERSIST_BUSTER,
  MAX_PERSISTED_MESSAGES_PER_SCOPE,
  shouldDehydrateCommunityQuery,
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
    channels: [{ categoryId: null, topic: "", position: 0, messageCount: 0, createdAt: "2026-10-01T00:00:00Z",
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

function publish(queryClient: QueryClient, data = envelope(), completeWindow = false, serverId = "server-1") {
  const normalized = normalizeForumSidebarEnvelope(data, null)
  publishCommunityForumSidebar(queryClient, {
    serverId,
    channels: data.channels,
    openers: data.included.parentMessages,
    proof: {
      token: captureCommunityLiveSnapshotToken(queryClient),
      signal: undefined,
    },
  })
  if (completeWindow) queryClient.setQueryData(communityKeys.forumSidebarThreads(serverId), {
    ...normalized.base, threads: [], window: {
      version: 1, accountId: "viewer", serverId,
      parents: getCanonicalCommunityChannels(queryClient).filter(row => row.serverId === serverId && row.type === "forum").map(row => row.id),
      base: normalized.base.threads.map(({ id, parentChannelId, parentMessageId }) => ({ id, parentChannelId, parentMessageId })), retained: null,
    },
  })
  return normalized
}

async function restorePersistedSidebar(queryClient: QueryClient) {
  await clearPersistedCache("viewer")
  const persister = createIdbPersister("viewer")
  await persister.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(queryClient, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
  const restored = await persister.restoreClient()
  expect(restored).toBeDefined()
  const restoredClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  hydrate(restoredClient, restored!.clientState)
  const registry = createCommunityDbRegistry(restoredClient, "viewer")
  registry.captureRestoredCollections(readCommunityRestoredCollections(restored, "viewer"))
  await registry.preload()
  const unregister = registerCommunityDbRegistry(registry)
  cleanups.push(unregister, registry.cleanup.bind(registry), () => clearPersistedCache("viewer"))
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: restoredClient },
    createElement(CommunityDbProvider, { registry }, children))
  return { queryClient: restoredClient, registry, wrapper }
}

function ProjectedSidebar() {
  const primary = useServerTreeProjection("server-1")
  const forum = useForumSidebarThreads("server-1", null)
  const grouped: Record<string, typeof forum.threads> = {}
  for (const thread of forum.threads) (grouped[thread.parentChannelId] ??= []).push(thread)
  if (forum.sidebar.status === "error") return createElement("div", { role: "alert" }, "Forum unavailable",
    createElement("button", { onClick: () => { void forum.refetch() } }, "Retry"))
  return createElement(ChannelSidebarRevealBoundary, {
    categories: primary?.categories ?? [], primaryReady: !!primary, forumProjectionMissing: !forum.projectionReady,
    scopeKey: "server:server-1", targetServerId: "server-1", serverId: "server-1", serverName: primary?.name ?? "",
    activeChannel: "forum-1", setActiveChannel: () => {}, isAdmin: false, noHeader: true, forumThreadsByParent: grouped,
  })
}

describe("forum sidebar canonical projection", () => {
  it("keeps visible posts through unrelated metadata admission and a same-window post switch", async () => {
    const { queryClient, wrapper } = await setup()
    publish(queryClient, envelopeFor(["post-1", "post-2"]), true)
    apiFetchMock.mockReturnValue(new Promise(() => {}))
    const frames: string[][] = []
    const view = renderHook(({ retainId }: { retainId: string }) => {
      const sidebar = useForumSidebarThreads("server-1", retainId)
      useLayoutEffect(() => { frames.push(sidebar.threads.map(({ id }) => id).sort()) })
      return sidebar
    }, { wrapper, initialProps: { retainId: "post-1" } })
    await waitFor(() => expect(view.result.current.threads).toHaveLength(2))
    frames.length = 0
    await act(async () => {
      publishCommunityChannelMetadata(queryClient, {
        metadata: {
          ...envelopeFor(["unlisted"]).channels[0],
          parentChannelId: "forum-1",
          parentMessageId: "unlisted-opener",
        },
        proof: { token: captureCommunityLiveSnapshotToken(queryClient), signal: undefined },
      })
    })
    view.rerender({ retainId: "post-2" })
    await waitFor(() => expect(view.result.current.threads.map(({ id }) => id).sort()).toEqual(["post-1", "post-2"]))
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(ids => ids.join(",") === "post-1,post-2")).toBe(true)
    expect(view.result.current.threads.some(({ id }) => id === "unlisted")).toBe(false)
  })

  it.each(["metadata-first", "archive-first"] as const)("keeps a direct archived opener excluded after notify refresh with %s completion", async (order) => {
    const { queryClient, registry, wrapper } = await setup()
    let resolveMetadata!: (value: unknown) => void
    let resolveSidebar!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockImplementation((url: string) => url.startsWith("/api/community/channels/")
      ? new Promise((resolve) => { resolveMetadata = resolve })
      : new Promise<SidebarThreadEnvelope>((resolve) => { resolveSidebar = resolve }))
    const rendered = renderHook(() => ({
      metadata: useChannelMetadata("server-1", "post-1"),
      sidebar: useForumSidebarThreads("server-1", "post-1"),
    }), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    const activityAt = new Date(Date.now() - 60_000).toISOString()
    const metadata = { categoryId: null, topic: "", position: 0, messageCount: 0,
      id: "post-1", serverId: "server-1", name: "Readable archived post", type: "thread",
      parentChannelId: "forum-1", parentMessageId: "opener-1", creatorId: "viewer",
      archived: false, lastMessageAt: activityAt, createdAt: activityAt,
    }
    const negative: SidebarThreadEnvelope = {
      ...envelopeFor(["post-2", "post-3", "post-4", "post-5", "post-6"]),
      retainedChannel: null,
      retainedDisposition: "opener-archived",
    }
    if (order === "metadata-first") {
      await act(async () => { resolveMetadata(conversationEntryFromChannel(metadata)) })
      await waitFor(() => expect(rendered.result.current.metadata.isVerified).toBe(true))
      await act(async () => { resolveSidebar(negative) })
    } else {
      await act(async () => { resolveSidebar(negative) })
      await waitFor(() => expect(rendered.result.current.sidebar.isSuccess).toBe(true))
      expect(registry.collections.channels.get("post-1")).toMatchObject({
        pending: true, tags: ["archived"], parentMessageId: null,
      })
      expect(registry.collections.channelMemberships.get("post-1:viewer:access")).toBeUndefined()
      await act(async () => { resolveMetadata(conversationEntryFromChannel(metadata)) })
    }
    await waitFor(() => expect(rendered.result.current.metadata.isVerified).toBe(true))
    await waitFor(() => expect(rendered.result.current.sidebar.isSuccess).toBe(true))
    act(() => {
      publishCommunityLiveSnapshot(queryClient, {
        snapshot: { kind: "server-detail", data: {
          id: "server-1", name: "Server", discriminator: "0001", description: "",
          icon: null, ownerId: "viewer", categories: [{
            id: "cat-1", name: "Forums", channels: [{
              id: "forum-1", name: "forum", active: false, unread: false, type: "forum",
            }],
          }],
          forumUnreadState: { "forum-1": { baseUnread: false, childIds: ["post-1"] } },
        } },
        proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(queryClient), signal: undefined },
      })
    })
    const expected = ["post-6", "post-5", "post-4", "post-3", "post-2"]
    await waitFor(() => expect(rendered.result.current.sidebar.threads.map(({ id }) => id)).toEqual(expected))
    expect(getForumSidebarBase(queryClient, "server-1").threads.map(({ id }) => id)).toEqual(expected)
    expect(registry.collections.channels.get("post-1")).toMatchObject({
      name: "Readable archived post", archived: false, pending: false, tags: ["archived"],
      parentChannelId: "forum-1", parentMessageId: "opener-1",
    })
    expect(registry.collections.channelMemberships.get("post-1:viewer:notify")).toBeDefined()
    expect(registry.collections.channelMemberships.get("post-1:viewer:access")).toBeDefined()
    expect(rendered.result.current.metadata.isVerified).toBe(true)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    rendered.unmount()
  })

  it("clears only the reserved opener archive tag on a current eligible response", async () => {
    const { queryClient, registry, wrapper } = await setup()
    publish(queryClient)
    act(() => {
      projectCommunityWsEventToDb(queryClient, {
        type: "community:channel.child_update", channelId: "post-1", parentChannelId: "forum-1",
        changes: { tags: ["bug", "archived"] },
      })
    })
    expect(getForumSidebarBase(queryClient, "server-1").threads).toEqual([])
    const eligible = envelope()
    eligible.retainedChannel = eligible.channels[0]
    eligible.retainedDisposition = "eligible"
    apiFetchMock.mockResolvedValue(eligible)
    const rendered = renderHook(() => useForumSidebarThreads("server-1", "post-1"), { wrapper })
    await waitFor(() => expect(rendered.result.current.threads.map(({ id }) => id)).toEqual(["post-1"]))
    expect(registry.collections.channels.get("post-1")).toMatchObject({ tags: ["bug"], archived: false })
    expect(getForumSidebarBase(queryClient, "server-1").threads.map(({ id }) => id)).toEqual(["post-1"])
    rendered.unmount()
  })

  it("preserves a newer WS opener archive against an older positive response and permits current unarchive", async () => {
    const { queryClient, registry, wrapper } = await setup()
    publish(queryClient)
    let resolveStale!: (value: SidebarThreadEnvelope) => void
    const eligible = envelope()
    eligible.retainedChannel = eligible.channels[0]
    eligible.retainedDisposition = "eligible"
    apiFetchMock.mockReturnValueOnce(new Promise<SidebarThreadEnvelope>((resolve) => { resolveStale = resolve }))
      .mockResolvedValue(eligible)
    const rendered = renderHook(() => useForumSidebarThreads("server-1", "post-1"), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    act(() => {
      projectCommunityWsEventToDb(queryClient, {
        type: "community:channel.child_update", channelId: "post-1", parentChannelId: "forum-1",
        changes: { tags: ["bug", "archived"] },
      })
    })
    await act(async () => { resolveStale(eligible) })
    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(rendered.result.current.threads).toEqual([]))
    expect(registry.collections.channels.get("post-1")?.tags).toEqual(["bug", "archived"])
    expect(getForumSidebarBase(queryClient, "server-1").threads).toEqual([])
    await act(async () => {
      projectCommunityWsEventToDb(queryClient, {
        type: "community:channel.child_update", channelId: "post-1", parentChannelId: "forum-1",
        changes: { tags: ["bug"] },
      })
      await reconcileForumSidebarArchiveTag(queryClient, "server-1", "post-1", false)
    })
    await waitFor(() => expect(rendered.result.current.threads.map(({ id }) => id)).toEqual(["post-1"]))
    expect(registry.collections.channels.get("post-1")?.tags).toEqual(["bug"])
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    rendered.unmount()
  })

  it("publishes archive qualification without overwriting newer unrelated metadata", async () => {
    const { queryClient, registry, wrapper } = await setup()
    publish(queryClient)
    act(() => {
      projectCommunityWsEventToDb(queryClient, {
        type: "community:channel.child_update", channelId: "post-1", parentChannelId: "forum-1",
        changes: { tags: ["bug"] },
      })
    })
    let resolveNegative!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise<SidebarThreadEnvelope>((resolve) => { resolveNegative = resolve }))
    const rendered = renderHook(() => useForumSidebarThreads("server-1", "post-1"), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    act(() => {
      projectCommunityWsEventToDb(queryClient, {
        type: "community:channel.child_update", channelId: "post-1", parentChannelId: "forum-1",
        changes: { name: "Newer title" },
      })
    })
    await act(async () => {
      resolveNegative({ ...envelopeFor([]), retainedChannel: null, retainedDisposition: "opener-archived" })
    })
    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true))
    act(() => { setCanonicalCommunityChannelMembership(queryClient, "post-1", "notify", true) })
    await waitFor(() => expect(rendered.result.current.threads).toEqual([]))
    expect(registry.collections.channels.get("post-1")).toMatchObject({
      name: "Newer title", tags: ["bug", "archived"], archived: false,
    })
    expect(getForumSidebarBase(queryClient, "server-1").threads).toEqual([])
    rendered.unmount()
  })

  it("keeps a notified text reply outside the forum sidebar after its message read", async () => {
    const { queryClient, registry, wrapper } = await setup()
    act(() => ingestServerDetail(registry, {
      id: "server-1", name: "Server", discriminator: "0001", description: "", icon: null, ownerId: "viewer",
      categories: [{ id: "cat-1", name: "Channels", channels: [
        { id: "forum-1", name: "forum", active: false, unread: false, type: "forum" },
        { id: "text-1", name: "text", active: false, unread: false, type: "text" },
      ] }],
    }))
    apiFetchMock.mockResolvedValue(envelope())
    const rendered = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper })
    await waitFor(() => expect(rendered.result.current.threads.map((row) => row.id)).toEqual(["post-1"]))
    act(() => {
      ingestMessages(registry, "text-1", [{ id: "text-opener", type: "chat", content: "Text reply opener", seq: 1,
        thread: { id: "text-child", name: "Text reply", messageCount: 1, lastReplyAt: new Date().toISOString() } }])
      setCanonicalCommunityChannelMembership(queryClient, "text-child", "notify", true)
    })
    await waitFor(() => expect(getCanonicalCommunityChannels(queryClient).some((row) => row.id === "text-child")).toBe(true))
    expect(getCanonicalCommunityMessages(queryClient).find((row) => row.id === "text-opener")?.content).toBe("Text reply opener")
    expect(rendered.result.current.threads.map((row) => row.id)).toEqual(["post-1"])
    expect(getForumSidebarBase(queryClient, "server-1").threads.map((row) => row.id)).toEqual(["post-1"])
    expect(registry.collections.channelMemberships.get("text-child:viewer:notify")).toBeDefined()
    rendered.unmount()
  })
  it("uses sidebar identity and opener while one protected metadata GET qualifies reading", async () => {
    const { queryClient, wrapper } = await setup()
    apiFetchMock.mockResolvedValueOnce(envelope())
    let retainId: string | null = null
    const sidebar = renderHook(() => useForumSidebarThreads("server-1", retainId), { wrapper })
    await waitFor(() => expect(sidebar.result.current.threads[0]?.title).toBe("Canonical title"))
    let releaseRetained!: (value: SidebarThreadEnvelope) => void
    const retained = new Promise<SidebarThreadEnvelope>((resolve) => { releaseRetained = resolve })
    apiFetchMock.mockImplementation((url) => url === "/api/community/channels/post-1/messages?entry=1" ? Promise.resolve(conversationEntryFromChannel({ categoryId: null, topic: "", position: 0, messageCount: 0, parentChannelId: "forum-1", parentMessageId: "opener-1", creatorId: null, lastMessageAt: null, ...envelope().channels[0], id: "post-1", serverId: "server-1", type: "thread", name: "Canonical title", archived: false, createdAt: new Date().toISOString() })) : retained)
    retainId = "post-1"
    sidebar.rerender()
    const route = renderHook(() => {
      const metadata = useChannelMetadata("server-1", "post-1")
      const opener = useForumOpenerHint("server-1", metadata.data?.parentMessageId, metadata.isVerified)
      return { metadata, opener }
    }, { wrapper })
    try {
      expect(route.result.current.metadata.identityKnown).toBe(false)
      expect(route.result.current.metadata.canRead).toBe(false)
      await waitFor(() => expect(route.result.current.metadata.canRead).toBe(true))
      expect(route.result.current.opener.data?.content).toBe("Canonical title")
      await waitFor(() => expect(apiFetchMock.mock.calls.some(([url]) => new URL(url, "http://localhost").searchParams.get("retainId") === "post-1")).toBe(true))
      expect(apiFetchMock.mock.calls.filter(([url]) => url === "/api/community/channels/post-1/messages?entry=1")).toHaveLength(1)
      expect(isChannelMetadataTokenCurrent(queryClient.getQueryData(conversationEntryOptions(queryClient, { serverId: "server-1", channelId: "post-1" }).queryKey)!.proof)).toBe(true)
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

  it("classifies retained route candidates and bounds an expired active extra in the canonical view", async () => {
    expect(resolveForumSidebarRouteCandidate(null, ["forum-1"], true)).toBeNull()
    expect(resolveForumSidebarRouteCandidate("forum-1", ["forum-1"], true)).toBeNull()
    expect(resolveForumSidebarRouteCandidate("post-6", ["forum-1"], true)).toBe("post-6")
    const { queryClient, wrapper } = await setup()
    const response = envelopeFor(["post-1", "post-2", "post-3", "post-4", "post-5", "post-6"])
    const expired = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString()
    Object.assign(response.channels[5]!, { activityAt: expired, lastMessageAt: expired, expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), unread: true })
    publish(queryClient, response)
    const rendered = renderHook(() => useForumSidebarProjection("server-1", "post-6", Date.now()), { wrapper })
    await waitFor(() => expect(rendered.result.current?.threads).toHaveLength(5))
    expect(rendered.result.current).toMatchObject({
      threads: expect.arrayContaining([expect.objectContaining({ id: "post-6", unread: true })]),
      parentUnread: { "forum-1": false },
    })
    rendered.rerender()
    rendered.unmount()
  })

  it("ignores incomplete child metadata while normalizing", () => {
    const response = envelope()
    response.channels[0] = { ...response.channels[0]!, serverId: undefined }
    expect(normalizeForumSidebarEnvelope(response, null, 0).channels).toEqual([])
  })

  it("ignores another user's notify row in both Sidebar views and bounded negative reconciliation", async () => {
    const { queryClient, registry, wrapper } = await setup()
    publish(queryClient)
    removeCanonicalCommunityChannelMembership(queryClient, "post-1", "notify")
    registry.collections.channelMemberships.utils.writeUpsert({ id: "post-1:other:notify",
      channelId: "post-1", userId: "other", relation: "notify", source: "explicit" })
    expect(getForumSidebarBase(queryClient, "server-1").threads).toEqual([])
    const rendered = renderHook(() => useForumSidebarProjection("server-1", null, Date.now()), { wrapper })
    await waitFor(() => expect(rendered.result.current?.threads).toEqual([]))
    apiFetchMock.mockResolvedValue(envelopeFor([]))
    const result = await reconcileForumSidebarNotifyMemberships(queryClient, "server-1")
    expect(result.removedIds).toEqual([])
    expect(registry.collections.channelMemberships.get("post-1:other:notify")).toBeDefined()
    expect(registry.collections.channels.get("post-1")?.unread).toBe(true)
    rendered.unmount()
  })

  it.each([null, "0", "expired"] as const)("shares ASCII candidates and one expiry/top-five/retain=$0 view selector", async (retainId) => {
    const { queryClient, registry, wrapper } = await setup()
    const data = envelopeFor(["0", "9", "A", "Z", "a", "z", "expired"])
    const expired = data.channels.find((row) => row.id === "expired")!
    expired.lastMessageAt = expired.activityAt = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString()
    publish(queryClient, data)
    const rendered = renderHook(() => useForumSidebarProjection("server-1", retainId, Date.now()), { wrapper })
    const expected = retainId === null ? ["z", "a", "Z", "A", "9"] : ["z", "a", "Z", "A", retainId]
    await waitFor(() => expect(rendered.result.current?.threads.map((row) => row.id)).toEqual(expected))
    expect(getForumSidebarBase(queryClient, "server-1").threads.map((row) => row.id)).toEqual(["z", "a", "Z", "A", "9", "0", "expired"])
    expect(projectForumSidebar(getCanonicalCommunityChannels(queryClient), getCanonicalCommunityChannelMemberships(queryClient),
      getCanonicalCommunityMessages(queryClient), registry.accountId, "server-1", retainId, Date.now()).threads)
      .toStrictEqual(rendered.result.current?.threads)
    rendered.unmount()
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
    publish(queryClient, envelope(), true)
    apiFetchMock.mockReturnValue(new Promise(() => {}))

    const frames: string[][] = []
    const rendered = renderHook(
      () => {
        const sidebar = useForumSidebarThreads("server-1", null)
        frames.push(sidebar.threads.map(({ id }) => id))
        return sidebar
      },
      { wrapper },
    )

    expect(frames[0]).toEqual(["post-1"])
    expect(rendered.result.current.threads).toEqual([
      expect.objectContaining({ id: "post-1", title: "Canonical title", unread: false }),
    ])
    expect(rendered.result.current.projectionReady).toBe(true)
    expect(rendered.result.current.fetchStatus).toBe("idle")
    rendered.unmount()
    await invalidateForumSidebarBaseExact(queryClient, "server-1")
  })

  it("projects complete first frames for remounted A to B to A cached servers", async () => {
    const { queryClient, registry, wrapper } = await setup()
    publish(queryClient, envelope(), true)
    ingestServerDetail(registry, {
      id: "server-2", name: "Second", discriminator: "0002", description: "", icon: null, ownerId: "viewer",
      categories: [{ id: "cat-2", name: "Second forums", channels: [{ id: "forum-2", name: "Second forum", type: "forum", active: false, unread: false }] }],
    })
    const second = envelopeFor(["post-2"])
    publish(queryClient, {
      ...second,
      channels: second.channels.map(channel => ({ ...channel, serverId: "server-2", parentChannelId: "forum-2" })),
      included: { parentMessages: second.included.parentMessages.map(message => ({ ...message, channelId: "forum-2", type: "chat" as const })) },
    }, true, "server-2")
    apiFetchMock.mockReturnValue(new Promise(() => {}))
    const frames: Array<{ serverId: string; ids: string[]; ready: boolean }> = []
    function Probe({ serverId }: { serverId: string }) {
      const sidebar = useForumSidebarThreads(serverId, null)
      frames.push({ serverId, ids: sidebar.threads.map(({ id }) => id), ready: sidebar.projectionReady })
      return null
    }
    const view = render(createElement(Probe, { key: "server-1", serverId: "server-1" }), { wrapper })
    expect(frames[0]).toEqual({ serverId: "server-1", ids: ["post-1"], ready: true })
    frames.length = 0
    view.rerender(createElement(Probe, { key: "server-2", serverId: "server-2" }))
    expect(frames[0]).toEqual({ serverId: "server-2", ids: ["post-2"], ready: true })
    frames.length = 0
    view.rerender(createElement(Probe, { key: "server-1", serverId: "server-1" }))
    expect(frames[0]).toEqual({ serverId: "server-1", ids: ["post-1"], ready: true })
    view.unmount()
  })

  it.each(["empty", "error"])("finishes the initial projection after a cold %s response", async (outcome) => {
    const { wrapper } = await setup()
    if (outcome === "empty") apiFetchMock.mockResolvedValue(envelopeFor([]))
    else apiFetchMock.mockRejectedValue(new Error("Forum read unavailable"))
    const frames: boolean[] = []
    const view = renderHook(() => {
      const sidebar = useForumSidebarThreads("server-1", null)
      frames.push(sidebar.projectionReady)
      return sidebar
    }, { wrapper })
    expect(frames[0]).toBe(false)
    await waitFor(() => expect(view.result.current.sidebar.status).toBe(outcome === "error" ? "error" : "ready"))
    expect(view.result.current.projectionReady).toBe(outcome !== "error")
    expect(view.result.current.threads).toEqual([])
    expect(view.result.current.isError).toBe(outcome === "error")
    view.unmount()
  })

  it("does not use a completed transport marker before canonical collections are ready", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let release!: () => void
    const registry = createCommunityDbRegistry(queryClient, "viewer", { waitForRestore: new Promise<void>((resolve) => { release = resolve }) })
    const unregister = registerCommunityDbRegistry(registry)
    cleanups.push(unregister, registry.cleanup.bind(registry))
    queryClient.setQueryData(communityKeys.forumSidebarThreads("server-1"), {
      threads: [], verifiedEpoch: 0, serverNow: new Date().toISOString(), serverClockOffsetMs: 0,
    })
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: queryClient },
      createElement(CommunityDbProvider, { registry }, children))
    const view = renderHook(() => useForumSidebarThreads("server-1", null, false), { wrapper })
    try {
      expect(view.result.current.projectionReady).toBe(false)
      await act(async () => {
        release()
        await registry.preload()
        ingestServerDetail(registry, { id: "server-1", name: "Server", discriminator: "0001", description: "", icon: null, ownerId: "viewer", categories: [] })
      })
      await waitFor(() => expect(view.result.current.projectionReady).toBe(true))
      expect(view.result.current.threads).toEqual([])
    } finally {
      release()
      view.unmount()
    }
  })

  it("keeps SSR and hydration consistent before projecting the mounted client clock", async () => {
    const { queryClient, wrapper } = await setup()
    publish(queryClient, envelope(), true)
    apiFetchMock.mockReturnValue(new Promise(() => {}))
    function Probe() {
      const sidebar = useForumSidebarThreads("server-1", null)
      return createElement("output", null, sidebar.projectionReady ? sidebar.threads.map(({ id }) => id).join(",") : "pending")
    }
    const node = createElement(wrapper, {}, createElement(Probe))
    const html = renderToString(node)
    expect(html).toContain(">pending<")
    const host = document.createElement("div")
    host.innerHTML = html
    document.body.append(host)
    const recoverable = vi.fn()
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)
    let root: ReturnType<typeof hydrateRoot> | undefined
    try {
      await act(async () => { root = hydrateRoot(host, node, { onRecoverableError: recoverable }) })
      expect(recoverable).not.toHaveBeenCalled()
      expect(host).toHaveTextContent("post-1")
    } finally {
      await act(async () => root?.unmount())
      host.remove()
      now.mockRestore()
    }
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

  it("keeps window references and request metadata without duplicated entities under a DB provider", async () => {
    const { queryClient, wrapper } = await setup()
    apiFetchMock.mockResolvedValue(envelope())
    const rendered = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper })

    await waitFor(() => expect(queryClient.getQueryData<{
      threads: unknown[]
      serverNow: string
    }>(communityKeys.forumSidebarThreads("server-1")))
      .toMatchObject({ threads: [], serverNow: expect.any(String), window: { version: 1, base: [{ id: "post-1", parentChannelId: "forum-1", parentMessageId: "opener-1" }] } }))
    rendered.unmount()
  })

  it("keeps normalized child unread and parent ownership in the canonical view", async () => {
    const { queryClient, wrapper } = await setup()
    publish(queryClient, envelope())
    const rendered = renderHook(() => useForumSidebarProjection("server-1", null, Date.now()), { wrapper })
    await waitFor(() => expect(rendered.result.current).toEqual({
      threads: [expect.objectContaining({ id: "post-1", unread: true })],
      parentUnread: { "forum-1": false },
    }))
    rendered.unmount()
  })

  it("preserves system opener types at the canonical ingress boundary", () => {
    const response = envelope()
    response.included.parentMessages[0]!.type = "system"

    expect(normalizeForumSidebarEnvelope(response, null, 0).openers.find((message) => message.id === "opener-1"))
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
    act(() => { purgeCommunityChannel(getCommunityDbRegistry(queryClient)!, "post-2") });
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
    act(() => { purgeCommunityChannel(getCommunityDbRegistry(queryClient)!, "forum-1") });
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
    const { queryClient, registry, wrapper } = await setup()
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
    expect(registry.collections.channels.get("post-1")).toMatchObject({
      serverId: "server-1", type: "thread", name: null, pending: true, tags: ["archived"],
      parentChannelId: null, parentMessageId: null,
    })
    expect(registry.collections.channelMemberships.get("post-1:viewer:access")).toBeUndefined()
    expect(registry.collections.channelMemberships.get("post-1:viewer:notify")).toBeUndefined()
    expect(rendered.result.current.threads).toEqual([])
    expect(getForumSidebarBase(queryClient, "server-1").threads).toEqual([])
    rendered.unmount()
  })

  it("does not revive a row when grant races archive and removal", async () => {
    const { queryClient } = await setup()
    let resolveGrant!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise((resolve) => { resolveGrant = resolve }))
    const grant = grantForumSidebarChild(queryClient, "server-1", "post-1").catch((error) => error)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    act(() => { purgeCommunityChannel(getCommunityDbRegistry(queryClient)!, "post-1") });
    await reconcileForumSidebarArchiveTag(queryClient, "server-1", "post-1", true)
    const retained = envelopeFor(["post-1"])
    resolveGrant({
      ...envelopeFor([]),
      canonicalChannels: [],
      retainedChannel: retained.channels[0],
      retainedDisposition: "eligible",
      included: retained.included,
    })
    expect((await grant) instanceof CancelledError).toBe(true)
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
    const { queryClient } = await setup()
    publish(queryClient, envelope(), true)
    const { queryClient: restoredClient, wrapper } = await restorePersistedSidebar(queryClient)
    apiFetchMock.mockReturnValue(new Promise(() => {}))
    const frames: string[][] = []
    const rendered = renderHook(
      () => {
        const sidebar = useForumSidebarThreads("server-1", null)
        frames.push(sidebar.threads.map(({ id }) => id))
        return sidebar
      },
      { wrapper },
    )
    expect(frames[0]).toEqual(["post-1"])
    expect(rendered.result.current.fetchStatus).toBe("fetching")
    const route = renderHook(() => useChannelMetadata("server-1", "post-1"), { wrapper })
    expect(route.result.current.isVerified).toBe(false)
    expect(route.result.current.canonical?.type).toBe("thread")
    route.unmount()
    rendered.unmount()
    await invalidateForumSidebarBaseExact(restoredClient, "server-1")
  })

  it.each(["post", "empty", "error"])("keeps a restored main-only tree hidden until its forum read settles with %s", async (outcome) => {
    const { queryClient } = await setup()
    const restored = await restorePersistedSidebar(queryClient)
    for (const name of ["channels", "channelMemberships", "messages"] as const) {
      expect(restored.registry.hasRestoredCollection(name)).toBe(true)
    }
    expect(restored.queryClient.getQueryData(communityKeys.forumSidebarThreads("server-1"))).toBeUndefined()
    let resolveForum!: (value: SidebarThreadEnvelope) => void
    let rejectForum!: (error: Error) => void
    let settled = false
    apiFetchMock.mockReturnValue(new Promise<SidebarThreadEnvelope>((resolve, reject) => { resolveForum = resolve; rejectForum = reject }))
    const view = render(createElement(ProjectedSidebar), { wrapper: restored.wrapper })
    try {
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
      expect(view.getByTestId(tid.channelSidebarPending("server-1"))).toBeInTheDocument()
      expect(view.queryByTestId(tid.channelRow("forum-1"))).toBeNull()
      await act(async () => {
        settled = true
        if (outcome === "error") rejectForum(new Error("Forum unavailable"))
        else resolveForum(outcome === "post" ? envelope() : envelopeFor([]))
      })
      await waitFor(() => expect(view.queryByTestId(tid.channelSidebarPending("server-1"))).toBeNull())
      if (outcome === "error") {
        expect(view.getByRole("alert")).toHaveTextContent("Forum unavailable")
        expect(view.queryByTestId(tid.channelRow("forum-1"))).toBeNull()
      } else expect(view.getByTestId(tid.channelRow("forum-1"))).toBeInTheDocument()
      if (outcome === "post") expect(view.getByTestId(tid.forumSidebarThread("post-1"))).toBeInTheDocument()
      else expect(view.queryByTestId(tid.forumSidebarThread("post-1"))).toBeNull()
      expect(restored.queryClient.getQueryState(communityKeys.forumSidebarThreads("server-1"))?.status)
        .toBe(outcome === "error" ? "error" : "success")
    } finally {
      if (!settled) await act(async () => { resolveForum(envelopeFor([])) })
      view.unmount()
    }
  })

  it("reveals a completed empty warm read on the first remount frame", async () => {
    const { wrapper } = await setup()
    apiFetchMock.mockResolvedValue(envelopeFor([]))
    const first = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper })
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true))
    first.unmount()
    apiFetchMock.mockClear()
    const frames: boolean[] = []
    const second = renderHook(() => {
      const forum = useForumSidebarThreads("server-1", null)
      frames.push(forum.projectionReady)
      return forum
    }, { wrapper })
    expect(frames[0]).toBe(true)
    expect(second.result.current.threads).toEqual([])
    expect(apiFetchMock).not.toHaveBeenCalled()
    second.unmount()
  })
  it.each(["primary-first", "forum-first"])("reveals one complete target with %s source completion", async order => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer")
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    cleanups.push(unregister, registry.cleanup.bind(registry))
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: queryClient }, createElement(CommunityDbProvider, { registry }, children))
    let release!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise<SidebarThreadEnvelope>(resolve => { release = resolve }))
    const view = render(createElement(ProjectedSidebar), { wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    const publishPrimary = () => ingestServerDetail(registry, { id: "server-1", name: "Server", discriminator: "0001", description: "", icon: null, ownerId: "viewer",
      categories: [{ id: "cat-1", name: "Forum", channels: [{ id: "forum-1", name: "Forum", type: "forum", active: false, unread: false }] }] })
    if (order === "primary-first") act(publishPrimary)
    else await act(async () => { release(envelope()) })
    expect(view.getByTestId(tid.channelSidebarPending("server-1"))).toBeVisible()
    expect(view.queryByTestId(tid.channelRow("forum-1"))).toBeNull()
    expect(view.queryByTestId(tid.forumSidebarThread("post-1"))).toBeNull()
    if (order === "primary-first") await act(async () => { release(envelope()) })
    else act(publishPrimary)
    await waitFor(() => expect(view.queryByTestId(tid.channelSidebarPending("server-1"))).toBeNull())
    expect(view.getByTestId(tid.channelRow("forum-1"))).toBeVisible()
    expect(view.getByTestId(tid.forumSidebarThread("post-1"))).toBeVisible()
    view.unmount()
  })

  it("ends an incomplete successful response as one error and accepts an explicit retry", async () => {
    const owner = await setup()
    apiFetchMock.mockResolvedValue({ ...envelope(), included: { parentMessages: [] } })
    const view = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper: owner.wrapper })
    await waitFor(() => expect(view.result.current.sidebar.status).toBe("error"))
    expect(apiFetchMock).toHaveBeenCalledOnce()
    expect(owner.queryClient.getQueryData(communityKeys.forumSidebarThreads("server-1"))).toBeUndefined()
    apiFetchMock.mockResolvedValue(envelope())
    await act(async () => { await view.result.current.refetch() })
    await waitFor(() => expect(view.result.current.sidebar.status).toBe("ready"))
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it.each(["memory", "restored"])("does not treat a single cached post as a complete %s window", async (kind) => {
    const owner = await setup()
    publish(owner.queryClient)
    const target = kind === "restored" ? await restorePersistedSidebar(owner.queryClient) : owner
    let release!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise<SidebarThreadEnvelope>(resolve => { release = resolve }))
    const view = render(createElement(ProjectedSidebar), { wrapper: target.wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    expect(view.getByTestId(tid.channelSidebarPending("server-1"))).toBeVisible()
    expect(view.queryByTestId(tid.channelRow("forum-1"))).toBeNull()
    expect(view.queryByTestId(tid.forumSidebarThread("post-1"))).toBeNull()
    await act(async () => { release(envelopeFor(["post-1", "post-2"])) })
    await waitFor(() => expect(view.queryByTestId(tid.channelSidebarPending("server-1"))).toBeNull())
    expect(view.getByTestId(tid.channelRow("forum-1"))).toBeVisible()
    expect(view.getByTestId(tid.forumSidebarThread("post-1"))).toBeVisible()
    expect(view.getByTestId(tid.forumSidebarThread("post-2"))).toBeVisible()
    view.unmount()
  })

  it("restores a completed empty window on its first frame while revalidating", async () => {
    const owner = await setup()
    apiFetchMock.mockResolvedValue(envelopeFor([]))
    const first = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper: owner.wrapper })
    await waitFor(() => expect(first.result.current.sidebar.status).toBe("ready"))
    first.unmount()
    const target = await restorePersistedSidebar(owner.queryClient)
    apiFetchMock.mockReturnValue(new Promise(() => {}))
    const frames: string[] = []
    const view = renderHook(() => {
      const result = useForumSidebarThreads("server-1", null)
      frames.push(result.sidebar.status)
      return result
    }, { wrapper: target.wrapper })
    expect(frames[0]).toBe("ready")
    expect(view.result.current.threads).toEqual([])
    expect(view.result.current.fetchStatus).toBe("fetching")
    view.unmount()
  })

  it("persists the last successful window after a refresh failure without restoring error or access proof", async () => {
    const owner = await setup()
    apiFetchMock.mockResolvedValue(envelope())
    const first = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper: owner.wrapper })
    await waitFor(() => expect(first.result.current.sidebar.status).toBe("ready"))
    apiFetchMock.mockRejectedValue(new Error("Refresh unavailable"))
    await act(async () => { await first.result.current.refetch() })
    expect(owner.queryClient.getQueryState(communityKeys.forumSidebarThreads("server-1"))?.status).toBe("error")
    await waitFor(() => expect(first.result.current.isError).toBe(true))
    expect(first.result.current.sidebar.status).toBe("ready")
    first.unmount()
    const target = await restorePersistedSidebar(owner.queryClient)
    expect(target.queryClient.getQueryState(communityKeys.forumSidebarThreads("server-1"))).toMatchObject({ status: "success", error: null, data: { verifiedEpoch: -1, threads: [] } })
    apiFetchMock.mockReturnValue(new Promise(() => {}))
    const view = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper: target.wrapper })
    expect(view.result.current.sidebar.status).toBe("ready")
    expect(view.result.current.threads.map(row => row.id)).toEqual(["post-1"])
    view.unmount()
  })

  it("rejects the window after the real message budget prunes its opener and starts a fresh read", async () => {
    const owner = await setup()
    publish(owner.queryClient, envelope(), true)
    ingestMessages(owner.registry, "forum-1", Array.from({ length: MAX_PERSISTED_MESSAGES_PER_SCOPE }, (_, index) => ({
      id: `newer-${index}`, type: "chat" as const, content: "Newer", seq: index + 2, createdAt: new Date().toISOString(),
    })))
    const target = await restorePersistedSidebar(owner.queryClient)
    expect(target.registry.collections.messages.get("opener-1")).toBeUndefined()
    expect(target.queryClient.getQueryData(communityKeys.forumSidebarThreads("server-1"))).toBeUndefined()
    let release!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise<SidebarThreadEnvelope>(resolve => { release = resolve }))
    const view = render(createElement(ProjectedSidebar), { wrapper: target.wrapper })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    expect(view.getByTestId(tid.channelSidebarPending("server-1"))).toBeVisible()
    await act(async () => { release(envelope()) })
    await waitFor(() => expect(view.getByTestId(tid.forumSidebarThread("post-1"))).toBeVisible())
    view.unmount()
  })

  it.each(["opener", "legacy-result"])("actively repairs a warm window after local %s loss without a retirement invalidation", async missing => {
    const owner = await setup()
    publish(owner.queryClient, envelope(), true)
    if (missing === "legacy-result") owner.queryClient.setQueryData(communityKeys.forumSidebarThreads("server-1"), {
      threads: [], serverNow: new Date().toISOString(), serverClockOffsetMs: 0, verifiedEpoch: -1,
    })
    let release!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise<SidebarThreadEnvelope>(resolve => { release = resolve }))
    const view = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper: owner.wrapper })
    if (missing === "opener") {
      expect(view.result.current.sidebar.status).toBe("ready")
      expect(apiFetchMock).not.toHaveBeenCalled()
      await act(async () => { await writeCommunityCollectionRows(owner.registry, "messages", [], row => row.id) })
    }
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    expect(view.result.current.sidebar.status).toBe("pending")
    expect(new URL(String(apiFetchMock.mock.calls[0]![0]), "http://localhost").pathname).toBe("/api/community/servers/server-1/channels")
    await act(async () => { release(envelope()) })
    await waitFor(() => expect(view.result.current.sidebar.status).toBe("ready"))
    expect(view.result.current.threads[0]).toMatchObject({ id: "post-1", title: "Canonical title" })
    view.unmount()
  })

  it("actively rereads an Infinity window when a referenced canonical post retires", async () => {
    const owner = await setup()
    publish(owner.queryClient, envelope(), true)
    let release!: (value: SidebarThreadEnvelope) => void
    apiFetchMock.mockReturnValue(new Promise<SidebarThreadEnvelope>(resolve => { release = resolve }))
    const view = renderHook(() => useForumSidebarThreads("server-1", null), { wrapper: owner.wrapper })
    expect(view.result.current.sidebar.status).toBe("ready")
    expect(apiFetchMock).not.toHaveBeenCalled()
    act(() => { purgeCommunityChannel(owner.registry, "post-1") })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    await act(async () => { release(envelopeFor([])) })
    await waitFor(() => expect(view.result.current.sidebar.status).toBe("ready"))
    expect(view.result.current.threads).toEqual([])
    expect(owner.registry.collections.channels.has("post-1")).toBe(false)
    view.unmount()
  })

  it("records the same base owner for grant and reconnect while keeping retained separate", async () => {
    const { queryClient } = await setup()
    const base = envelopeFor(["base-post"])
    const extra = envelopeFor(["retained-post"])
    apiFetchMock.mockResolvedValue({ ...base, canonicalChannels: base.channels, retainedChannel: extra.channels[0], retainedDisposition: "eligible",
      included: { parentMessages: [...base.included.parentMessages, ...extra.included.parentMessages] } })
    await grantForumSidebarChild(queryClient, "server-1", "retained-post")
    expect(queryClient.getQueryData(communityKeys.forumSidebarThreads("server-1"))).toMatchObject({ threads: [], window: {
      base: [{ id: "base-post" }], retained: { id: "retained-post", disposition: "eligible", reference: { id: "retained-post" } },
    } })
    apiFetchMock.mockResolvedValue(envelopeFor([]))
    await reconcileForumSidebarNotifyMemberships(queryClient, "server-1")
    expect(queryClient.getQueryData(communityKeys.forumSidebarThreads("server-1"))).toMatchObject({ threads: [], window: { base: [], retained: null } })
  })

})
