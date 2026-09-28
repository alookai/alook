import React, { useLayoutEffect } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AccountAttentionSnapshot } from "@alook/shared"
import { act, render, waitFor } from "@/test/react-dom-harness"
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
import { useAccountAttention } from "./use-account-attention"
import { useInboxAttention } from "./use-inbox"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

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

async function createHarness({ owner = false }: { owner?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const registry = createCommunityDbRegistry(queryClient, "viewer")
  await registry.preload()
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
  const rendered = render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        CommunityDbProvider,
        { registry },
        React.createElement(owner ? OwnerProbe : Probe),
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
})

describe("useInboxAttention", () => {
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
    apiFetchMock.mockResolvedValueOnce(forumSnapshot())
    const harness = await createHarness({ owner: true })
    try {
      await waitFor(() => expect(harness.latest.exactAttentionCount).toBe(2))
      apiFetchMock.mockRejectedValueOnce(new Error("offline"))
      await act(async () => { await harness.latest.refetch() })
      expect(harness.latest.exactAttentionCount).toBe(2)
      expect(harness.latest.isInitialError).toBe(false)
    } finally {
      harness.dispose()
    }
  })

  it("exposes an initial error instead of an empty success", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("offline"))
    const harness = await createHarness({ owner: true })
    try {
      await waitFor(() => expect(harness.latest.isInitialError).toBe(true))
      expect(harness.latest.isLoading).toBe(false)
      expect(harness.latest.exactAttentionCount).toBe(0)
    } finally {
      harness.dispose()
    }
  })
})
