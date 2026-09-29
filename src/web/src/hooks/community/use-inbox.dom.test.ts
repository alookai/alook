import React, { useLayoutEffect } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AccountAttentionSnapshot } from "@alook/shared"
import type { CommunityProfile } from "@/lib/community/models/people"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  CommunityDbProvider,
} from "@/lib/community-db/projections"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import {
  clearAttentionScopeOptimistically,
  ingestAttentionSnapshot,
} from "@/lib/community-db/sync"
import { useCommunityWsStore } from "@/stores/community/ws"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"
import { writeCommunityCollectionRows } from "@/lib/community-db/collection-mutations"
import { seedCommunityServers } from "@/lib/community-db/server-test-seed"
import { useAccountAttention } from "./use-account-attention"
import { useInboxAttention, useInboxMarked, useMessageMarked } from "./use-inbox"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function emptyAttentionSnapshot(): AccountAttentionSnapshot {
  return {
    scopes: [],
    items: [],
    limit: 100,
    truncated: false,
    included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
  }
}

function emptyResource(path: unknown) {
  if (path === "/api/community/users/me/read-state") {
    return { revision: 0, readStates: [] }
  }
  if (path === "/api/community/users/me/server-folders") return { folders: [] }
  if (path === "/api/community/users/me/notifications") return []
  if (path === "/api/community/users/me/attention") return emptyAttentionSnapshot()
  if (path === "/api/community/users/me/dms") return { conversations: [] }
  if (path === "/api/community/servers") return { servers: [] }
  throw new Error(`unexpected API fetch: ${String(path)}`)
}

function forumSnapshot(): AccountAttentionSnapshot {
  const channel = (
    id: string,
    name: string,
    type: "forum" | "thread",
    parentChannelId: string | null,
    parentMessageId: string | null,
    openerSeq?: number,
  ) => ({
    id,
    serverId: "server",
    name,
    type,
    parentChannelId,
    parentMessageId,
    creatorId: null,
    archived: false,
    lastMessageAt: `2026-09-28T00:00:${openerSeq ?? 30}.000Z`,
    ...(openerSeq === undefined ? {} : { openerSeq, openerUnread: true }),
  })
  return {
    scopes: [{
      scopeId: "forum",
      channelId: "forum",
      serverId: "server",
      parentChannelId: null,
      ordinaryUnread: true,
      lastUnreadSeq: 20,
      lastAttentionSeq: null,
      attentionCount: 0,
    }],
    items: [10, 20].map((seq) => ({
      id: `forum_post:child-${seq}`,
      kind: "forum_post" as const,
      sourceId: `child-${seq}`,
      scopeId: "forum",
      messageId: `opener-${seq}`,
      actorUserId: null,
      childChannelId: `child-${seq}`,
      openerSeq: seq,
      readTarget: { channelId: "forum", seq },
      createdAt: `2026-09-28T00:00:${seq}.000Z`,
    })),
    limit: 100,
    truncated: false,
    included: {
      servers: [{ id: "server", name: "Server", discriminator: "0001" }],
      channels: [
        channel("forum", "Forum", "forum", null, null),
        channel("child-10", "Derived A", "thread", "forum", "opener-10", 10),
        channel("child-20", "Derived B", "thread", "forum", "opener-20", 20),
      ],
      dms: [],
      profiles: [],
      messages: [10, 20].map((seq) => ({
        id: `opener-${seq}`,
        channelId: "forum",
        type: "chat" as const,
        seq,
        createdAt: `2026-09-28T00:00:${seq}.000Z`,
        content: `Post ${seq}`,
      })),
    },
  }
}

function truncatedAttentionOnlySnapshot(): AccountAttentionSnapshot {
  return {
    scopes: [{
      scopeId: "channel",
      channelId: "channel",
      serverId: "server",
      parentChannelId: null,
      ordinaryUnread: false,
      lastUnreadSeq: 30,
      lastAttentionSeq: 30,
      attentionCount: 3,
    }],
    items: [],
    limit: 1,
    truncated: true,
    included: {
      servers: [{ id: "server", name: "Server", discriminator: "0001" }],
      channels: [{
        id: "channel",
        serverId: "server",
        name: "Attention only",
        type: "text",
        parentChannelId: null,
        parentMessageId: null,
        creatorId: null,
        archived: false,
        lastMessageAt: "2026-09-28T00:00:30.000Z",
      }],
      dms: [],
      profiles: [],
      messages: [],
    },
  }
}

function truncatedAttentionWithBoundedItemSnapshot(): AccountAttentionSnapshot {
  const snapshot = truncatedAttentionOnlySnapshot()
  return {
    ...snapshot,
    items: [{
      id: "mention:mention",
      kind: "mention",
      sourceId: "mention",
      scopeId: "channel",
      messageId: "message",
      actorUserId: "author",
      createdAt: "2026-09-28T00:00:30.000Z",
    }],
    included: {
      ...snapshot.included,
      profiles: [{
        userId: "author",
        name: "Author",
        discriminator: "0002",
        avatar: "",
        avatarVersion: 0,
      }],
      messages: [{
        id: "message",
        channelId: "channel",
        type: "chat",
        authorId: "author",
        authorName: "Author",
        seq: 30,
        createdAt: "2026-09-28T00:00:30.000Z",
        content: "hello",
      }],
    },
  }
}

function emptyAttentionScopeSnapshot(): AccountAttentionSnapshot {
  const snapshot = truncatedAttentionOnlySnapshot()
  return {
    ...snapshot,
    scopes: [{
      ...snapshot.scopes[0]!,
      lastUnreadSeq: 0,
      lastAttentionSeq: null,
      attentionCount: 0,
    }],
    limit: 100,
    truncated: false,
  }
}

function dmSnapshot({ mention = false }: { mention?: boolean } = {}): AccountAttentionSnapshot {
  return {
    scopes: [{
      scopeId: "dm",
      channelId: "dm",
      serverId: null,
      parentChannelId: null,
      ordinaryUnread: !mention,
      lastUnreadSeq: 9,
      lastAttentionSeq: mention ? 9 : null,
      attentionCount: mention ? 1 : 0,
    }],
    items: mention ? [{
      id: "mention:dm-mention",
      kind: "mention",
      sourceId: "dm-mention",
      scopeId: "dm",
      messageId: "dm-message",
      actorUserId: "peer",
      createdAt: "2026-09-28T00:00:09.000Z",
    }] : [],
    limit: 100,
    truncated: false,
    included: {
      servers: [],
      channels: [],
      dms: [{
        id: "dm",
        userId: "peer",
        name: "Peer",
        discriminator: "0002",
        avatar: "P",
        avatarVersion: 2,
        lastMessageAt: "2026-09-28T00:00:09.000Z",
        lastUnreadSeq: 9,
      }],
      profiles: [{
        userId: "peer",
        name: "Peer",
        discriminator: "0002",
        avatar: "P",
        avatarVersion: 2,
      }],
      messages: mention ? [{
        id: "dm-message",
        channelId: "dm",
        type: "chat",
        authorId: "peer",
        authorName: "Peer",
        seq: 9,
        createdAt: "2026-09-28T00:00:09.000Z",
        content: "hello",
      }] : [],
    },
  }
}

function childThreadSnapshot(): AccountAttentionSnapshot {
  return {
    scopes: [{
      scopeId: "child",
      channelId: "child",
      serverId: "server",
      parentChannelId: "parent",
      ordinaryUnread: true,
      lastUnreadSeq: 7,
      lastAttentionSeq: null,
      attentionCount: 0,
    }],
    items: [],
    limit: 100,
    truncated: false,
    included: {
      servers: [{ id: "server", name: "Server", discriminator: "0001" }],
      channels: [{
        id: "parent",
        serverId: "server",
        name: "Parent",
        type: "text",
        parentChannelId: null,
        parentMessageId: null,
        creatorId: null,
        archived: false,
        lastMessageAt: "2026-09-28T00:00:06.000Z",
      }, {
        id: "child",
        serverId: "server",
        name: "Child",
        type: "thread",
        parentChannelId: "parent",
        parentMessageId: "opener",
        creatorId: null,
        archived: false,
        lastMessageAt: "2026-09-28T00:00:07.000Z",
        openerSeq: 7,
        openerUnread: false,
      }],
      dms: [],
      profiles: [],
      messages: [{
        id: "opener",
        channelId: "parent",
        type: "chat",
        seq: 7,
        createdAt: "2026-09-28T00:00:07.000Z",
        content: "Child",
      }],
    },
  }
}

function friendRequestSnapshot(): AccountAttentionSnapshot {
  return {
    scopes: [],
    items: [{
      id: "friend_request:request",
      kind: "friend_request",
      sourceId: "request",
      scopeId: null,
      messageId: null,
      actorUserId: "requester",
      createdAt: "2026-09-28T00:00:05.000Z",
    }],
    limit: 100,
    truncated: false,
    included: {
      servers: [],
      channels: [],
      dms: [],
      profiles: [{
        userId: "requester",
        name: "Requester",
        discriminator: "0004",
        avatar: "R",
        avatarVersion: 4,
      }],
      messages: [],
    },
  }
}

async function createHarness({
  owner = false,
  previewProfiles,
  allowPreloadError = false,
}: {
  owner?: boolean
  previewProfiles?: ReadonlyMap<string, CommunityProfile>
  allowPreloadError?: boolean
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const registry = createCommunityDbRegistry(queryClient, "viewer")
  if (allowPreloadError) await registry.preload().catch(() => undefined)
  else await registry.preload()
  seedCommunityServers(registry, { servers: [{
    id: "server",
    name: "Server",
    discriminator: "0001",
    initial: "S",
    active: false,
    unread: false,
    mentions: 0,
    ownerId: "viewer",
  }] })
  const unregister = registerCommunityDbRegistry(registry)
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
  let latest: ReturnType<typeof useInboxAttention> | undefined
  const paints: Array<{ count: number; children: string[] }> = []
  function Probe() {
    const attention = useInboxAttention()
    latest = attention
    useLayoutEffect(() => {
      paints.push({
        count: attention.exactAttentionCount,
        children: attention.servers.flatMap((server) => (
          server.channels.flatMap((channel) => channel.children.map((child) => child.channelId))
        )),
      })
    })
    return null
  }
  function OwnerProbe() {
    useAccountAttention()
    return React.createElement(Probe)
  }
  const probe = React.createElement(owner ? OwnerProbe : Probe)
  const rendered = render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        CommunityDbProvider,
        { registry },
        previewProfiles
          ? React.createElement(CommunityPreviewProfileOwner, { profiles: previewProfiles }, probe)
          : probe,
      ),
    ),
  )
  return {
    queryClient,
    registry,
    paints,
    rendered,
    get latest() {
      if (!latest) throw new Error("attention hook did not mount")
      return latest
    },
    dispose() {
      rendered.unmount()
      unregister()
    },
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockImplementation(emptyResource)
})

describe("useInboxAttention", () => {
  it("rejects an explicit attention refetch when no registry owns the query", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rendered = renderHook(() => useAccountAttention(), {
      wrapper: ({ children }: React.PropsWithChildren) => React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children,
      ),
    })

    let outcome: Awaited<ReturnType<typeof rendered.result.current.refetch>> | undefined
    await act(async () => {
      outcome = await rendered.result.current.refetch()
    })

    expect(outcome?.error).toMatchObject({
      message: "account attention collection is unavailable",
    })
    rendered.unmount()
  })

  it("rejects stale marked and message-mark responses instead of publishing empty success", async () => {
    const wrapperFor = (queryClient: QueryClient) => function Wrapper({
      children,
    }: React.PropsWithChildren) {
      return React.createElement(QueryClientProvider, { client: queryClient }, children)
    }

    apiFetchMock.mockResolvedValueOnce({ marked: [], stale: true })
    const marked = renderHook(() => useInboxMarked(true), {
      wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    })
    await waitFor(() => expect(marked.result.current.error).toMatchObject({
      name: "StaleReadError",
    }))
    expect(marked.result.current.data).toBeUndefined()
    marked.unmount()

    apiFetchMock.mockResolvedValueOnce({ marked: false, stale: true })
    const messageMarked = renderHook(() => useMessageMarked("message", true), {
      wrapper: wrapperFor(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    })
    await waitFor(() => expect(messageMarked.result.current.error).toMatchObject({
      name: "StaleReadError",
    }))
    expect(messageMarked.result.current.data).toBeUndefined()
    messageMarked.unmount()
  })

  it("projects a DM only while its canonical owner is present", async () => {
    const harness = await createHarness()
    try {
      act(() => ingestAttentionSnapshot(harness.registry, dmSnapshot()))
      await waitFor(() => expect(harness.latest.dms).toEqual([expect.objectContaining({
        channelId: "dm",
        otherUserName: "Peer",
        lastUnreadSeq: 9,
      })]))

      act(() => {
        writeCommunityCollectionRows(
          harness.registry,
          "profiles",
          [...harness.registry.collections.profiles.values()].filter((row) => row.userId !== "peer"),
          (row) => row.userId,
        )
      })
      await waitFor(() => expect(harness.latest.dms).toEqual([]))
    } finally {
      harness.dispose()
    }
  })

  it("projects child opener fields and skips the child when its parent disappears", async () => {
    const harness = await createHarness()
    try {
      act(() => ingestAttentionSnapshot(harness.registry, childThreadSnapshot()))
      await waitFor(() => expect(harness.latest.servers[0]?.channels[0]?.children[0])
        .toMatchObject({
          channelId: "child",
          parentChannelId: "parent",
          openerMessageId: "opener",
          openerSeq: 7,
          openerUnread: false,
        }))

      act(() => {
        writeCommunityCollectionRows(
          harness.registry,
          "channels",
          [...harness.registry.collections.channels.values()].filter((row) => row.id !== "parent"),
          (row) => row.id,
        )
      })
      await waitFor(() => expect(harness.latest.servers[0]?.channels ?? []).toEqual([]))
    } finally {
      harness.dispose()
    }
  })

  it("uses forum-item fallback rows and sorts parent and child channels deterministically", async () => {
    const snapshot = forumSnapshot()
    snapshot.scopes[0] = {
      ...snapshot.scopes[0]!,
      ordinaryUnread: false,
    }
    snapshot.scopes.push({
      scopeId: "direct",
      channelId: "direct",
      serverId: "server",
      parentChannelId: null,
      ordinaryUnread: true,
      lastUnreadSeq: 40,
      lastAttentionSeq: null,
      attentionCount: 0,
    })
    snapshot.included.channels.push({
      id: "direct",
      serverId: "server",
      name: "Direct",
      type: "text",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      archived: false,
      lastMessageAt: "2026-09-28T00:00:40.000Z",
    })
    const harness = await createHarness()
    try {
      act(() => ingestAttentionSnapshot(harness.registry, snapshot))
      await waitFor(() => expect(harness.latest.servers[0]?.channels.map((row) => row.channelId))
        .toEqual(["direct", "forum"]))
      expect(harness.latest.servers[0]?.channels[1]).toMatchObject({
        channelId: "forum",
        hasDirectUnread: false,
      })
      expect(harness.latest.servers[0]?.channels[1]?.children.map((row) => row.channelId))
        .toEqual(["child-20", "child-10"])
    } finally {
      harness.dispose()
    }
  })

  it("falls back nullable friend identity fields and skips a missing profile", async () => {
    const nullableProfile = new Map<string, CommunityProfile>([["requester", {
      id: "requester",
      name: null,
      avatar: null,
      avatarVersion: null,
    } as unknown as CommunityProfile]])
    const fallbackHarness = await createHarness({ previewProfiles: nullableProfile })
    try {
      act(() => ingestAttentionSnapshot(fallbackHarness.registry, friendRequestSnapshot()))
      await waitFor(() => expect(fallbackHarness.latest.friendRequests).toEqual([{
        id: "request",
        userId: "requester",
        name: "Deleted user",
        avatar: "",
        avatarVersion: null,
        createdAt: "2026-09-28T00:00:05.000Z",
      }]))
    } finally {
      fallbackHarness.dispose()
    }

    const missingHarness = await createHarness({ previewProfiles: new Map() })
    try {
      act(() => ingestAttentionSnapshot(missingHarness.registry, friendRequestSnapshot()))
      await waitFor(() => expect(missingHarness.latest.friendRequests).toEqual([]))
    } finally {
      missingHarness.dispose()
    }
  })

  it("uses the DM owner name for a DM mention", async () => {
    const harness = await createHarness()
    try {
      act(() => ingestAttentionSnapshot(harness.registry, dmSnapshot({ mention: true })))
      await waitFor(() => expect(harness.latest.mentions).toEqual([expect.objectContaining({
        id: "dm-mention",
        server: "Peer",
        channelId: "dm",
      })]))
    } finally {
      harness.dispose()
    }
  })

  it("publishes a canonical marked row when the marked surface is enabled", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer")
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    apiFetchMock.mockResolvedValueOnce({
      marked: [{
        id: "mark",
        server: "Server",
        serverId: "server",
        channel: "General",
        channelId: "channel",
        m: {
          id: "message",
          type: "chat",
          seq: 5,
          createdAt: "2026-09-28T00:00:05.000Z",
          content: "keep",
        },
      }],
    })
    const rendered = renderHook(() => useInboxMarked(true), {
      wrapper: ({ children }: React.PropsWithChildren) => React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(CommunityDbProvider, { registry }, children),
      ),
    })
    try {
      await waitFor(() => expect(rendered.result.current.marked).toEqual([expect.objectContaining({
        id: "mark",
        channelId: "channel",
        m: expect.objectContaining({ id: "message", content: "keep" }),
      })]))
    } finally {
      rendered.unmount()
      unregister()
    }
  })

  it("counts an aggregate-only attention conversation when bounded items are absent", async () => {
    const harness = await createHarness()
    try {
      act(() => ingestAttentionSnapshot(harness.registry, truncatedAttentionOnlySnapshot()))
      await waitFor(() => expect(harness.latest.exactAttentionCount).toBe(1))
      expect(harness.latest.servers[0]?.channels[0]).toMatchObject({
        channelId: "channel",
        mentionCount: 3,
        hasDirectUnread: true,
      })
      expect(harness.latest.mentions).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  it("does not double-count the conversation when its bounded item arrives", async () => {
    const harness = await createHarness()
    try {
      act(() => ingestAttentionSnapshot(harness.registry, truncatedAttentionOnlySnapshot()))
      await waitFor(() => expect(harness.latest.exactAttentionCount).toBe(1))
      act(() => ingestAttentionSnapshot(
        harness.registry,
        truncatedAttentionWithBoundedItemSnapshot(),
      ))
      await waitFor(() => expect(harness.latest.mentions).toHaveLength(1))
      expect(harness.latest.exactAttentionCount).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  it("does not create a row or count for an empty attention-only scope", async () => {
    const harness = await createHarness()
    try {
      act(() => ingestAttentionSnapshot(harness.registry, emptyAttentionScopeSnapshot()))
      await waitFor(() => expect(harness.latest.exactAttentionCount).toBe(0))
      expect(harness.latest.servers).toEqual([])
      expect(harness.latest.hasUnread).toBe(false)
    } finally {
      harness.dispose()
    }
  })

  it("publishes two unread forum siblings as two exact presentation rows", async () => {
    const harness = await createHarness()
    try {
      act(() => ingestAttentionSnapshot(harness.registry, forumSnapshot()))
      await waitFor(() => {
        expect(harness.latest.servers[0]?.channels[0]?.children.map((row) => row.channelId))
          .toEqual(["child-20", "child-10"])
      })
      expect(harness.latest.servers[0]?.channels[0]).toMatchObject({
        channelId: "forum",
        hasDirectUnread: false,
      })
      expect(harness.latest.exactAttentionCount).toBe(2)
      expect(harness.latest.mentions).toEqual([])
    } finally {
      harness.dispose()
    }
  })

  it("removes only the older forum unit when its parent read target advances", async () => {
    const harness = await createHarness()
    try {
      act(() => ingestAttentionSnapshot(harness.registry, forumSnapshot()))
      await waitFor(() => expect(harness.latest.exactAttentionCount).toBe(2))
      act(() => {
        clearAttentionScopeOptimistically(harness.registry, "forum", 10)
      })
      await waitFor(() => {
        expect(harness.latest.servers[0]?.channels[0]?.children.map((row) => row.channelId))
          .toEqual(["child-20"])
      })
      expect(harness.latest.exactAttentionCount).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  it("never paints a positive badge without its forum rows", async () => {
    const harness = await createHarness()
    try {
      act(() => ingestAttentionSnapshot(harness.registry, forumSnapshot()))
      await waitFor(() => expect(harness.latest.exactAttentionCount).toBe(2))
      expect(harness.paints.some((paint) => paint.count > 0 && paint.children.length === 0))
        .toBe(false)
    } finally {
      harness.dispose()
    }
  })

  it("keeps the last complete state when a refresh fails", async () => {
    const attentionFetch = vi.fn()
      .mockResolvedValueOnce(forumSnapshot())
      .mockRejectedValueOnce(new Error("offline"))
    apiFetchMock.mockImplementation((path) => (
      path === "/api/community/users/me/attention"
        ? attentionFetch()
        : emptyResource(path)
    ))
    const harness = await createHarness({ owner: true })
    try {
      await waitFor(() => expect(harness.latest.exactAttentionCount).toBe(2))
      await act(async () => { await harness.latest.refetch() })
      expect(harness.latest.exactAttentionCount).toBe(2)
      expect(harness.latest.isInitialError).toBe(false)
    } finally {
      harness.dispose()
    }
  })

  it("exposes an initial error instead of an empty success", async () => {
    apiFetchMock.mockImplementation((path) => (
      path === "/api/community/users/me/attention"
        ? Promise.reject(new Error("offline"))
        : emptyResource(path)
    ))
    const harness = await createHarness({ owner: true, allowPreloadError: true })
    try {
      await waitFor(() => expect(harness.latest.isInitialError).toBe(true))
      expect(harness.latest.isLoading).toBe(false)
      expect(harness.latest.exactAttentionCount).toBe(0)
    } finally {
      harness.dispose()
    }
  })
})
