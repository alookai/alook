import { afterEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { ServerDetail, ServersResponse } from "@/hooks/community/use-servers"
import type { CoveredReplicaProjection } from "./store"
import {
  hasCoveredCommunityReplicaTarget,
  communityReplicaMessageSearchCoverage,
  seedCommunityReplicaBootstrapQueries,
  seedCommunityReplicaQueries,
  retireCommunityReplicaQueryScopes,
} from "./query-seed"
import {
  commitCommunityReplicaReadWal,
  listCommunityReplicaReadWal,
} from "./read-wal"

const lease = {
  epoch: "lease-1",
  checkedAt: "2026-01-01T00:00:00.000Z",
  validUntil: "2026-01-02T00:00:00.000Z",
}

const projection = {
  meta: { key: "snapshot", protocolVersion: 1, snapshotId: "snap-1", takenAt: lease.checkedAt },
  frontier: [
    { scope: { kind: "account", id: "viewer" }, revision: 1 },
    { scope: { kind: "server", id: "s1" }, revision: 2 },
    { scope: { kind: "channel", id: "c1" }, revision: 3 },
  ],
  coverage: [
    { scope: { kind: "account", id: "viewer" }, revision: 1, completeness: "complete", permission: lease, messageRange: null },
    { scope: { kind: "server", id: "s1" }, revision: 2, completeness: "complete", permission: lease, messageRange: null },
    { scope: { kind: "channel", id: "c1" }, revision: 3, completeness: "partial", permission: lease, messageRange: { firstSeq: 8, lastSeq: 9, hasOlder: true, hasNewer: false } },
  ],
  entities: [
    { key: "server", scopeKey: "account:viewer", entity: { kind: "server", id: "s1" }, value: { id: "s1", name: "Alook", discriminator: "0001", description: "desc", ownerId: "owner", icon: null, initial: "A", isOwner: false, railOrder: 0, joinedAt: lease.checkedAt, unread: true, mentions: 1, unreadSources: [{ channelId: "c1", lastUnreadSeq: 9 }], mentionSources: [] } },
    { key: "category", scopeKey: "server:s1", entity: { kind: "category", id: "cat" }, value: { id: "cat", serverId: "s1", name: "General", position: 0, private: false, creatorId: null } },
    { key: "channel", scopeKey: "server:s1", entity: { kind: "channel", id: "c1" }, value: { id: "c1", serverId: "s1", categoryId: "cat", name: "chat", position: 0, createdAt: lease.checkedAt, type: "text", creatorId: null } },
    { key: "unread", scopeKey: "server:s1", entity: { kind: "unread-source", id: "c1" }, value: { channelId: "c1", serverId: "s1", parentChannelId: null, lastUnreadSeq: 9, lastAttentionSeq: null } },
    { key: "read", scopeKey: "account:viewer", entity: { kind: "read-state", id: "c1" }, value: { channelId: "c1", lastReadMessageId: "m8", lastReadAt: "2026-01-01T00:00:08.000Z", lastReadSeq: 8 } },
    { key: "m8", scopeKey: "channel:c1", entity: { kind: "message", id: "m8" }, value: { id: "m8", type: "chat", seq: 8, createdAt: "2026-01-01T00:00:08.000Z", content: "eight" } },
    { key: "m9", scopeKey: "channel:c1", entity: { kind: "message", id: "m9" }, value: { id: "m9", channelId: "c1", authorId: "author", type: "chat", seq: 9, createdAt: "2026-01-01T00:00:09.000Z", content: "nine", thread: { id: "thread-1", name: "Replies", messageCount: 1, lastReplyAt: "2026-01-01T00:00:10.000Z" } } },
  ],
} as unknown as CoveredReplicaProjection

describe("community Replica query seed", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("publishes an atomic bootstrap into the query cache without an IDB reread", () => {
    const queryClient = new QueryClient()
    seedCommunityReplicaBootstrapQueries(queryClient, {
      protocolVersion: 1,
      snapshotId: projection.meta.snapshotId,
      takenAt: projection.meta.takenAt,
      frontier: projection.frontier,
      coverage: projection.coverage,
      facts: projection.entities.map(({ scopeKey: _scopeKey, key: _key, ...fact }) => ({
        scope: fact.entity.kind === "server"
          ? { kind: "account" as const, id: "viewer" }
          : fact.entity.kind === "message"
            ? { kind: "channel" as const, id: "c1" }
            : { kind: "server" as const, id: "s1" },
        entity: fact.entity,
        value: fact.value,
      })),
    } as never)

    expect(hasCoveredCommunityReplicaTarget(queryClient, "c1")).toBe(true)
    expect(queryClient.getQueryData(communityKeys.channelMessages("c1"))).toBeTruthy()
  })

  it("projects covered canonical facts into render-ready query shapes", () => {
    const queryClient = new QueryClient()
    seedCommunityReplicaQueries(queryClient, projection)

    expect(queryClient.getQueryData(communityKeys.servers())).toMatchObject({
      servers: [{ id: "s1", active: false, unread: true }],
    })
    expect(queryClient.getQueryData(communityKeys.server("s1"))).toMatchObject({
      id: "s1",
      categories: [{ id: "cat", channels: [{ id: "c1", active: false, unread: true }] }],
    })
    expect(queryClient.getQueryData(communityKeys.channelMessages("c1"))).toEqual({
      pages: [{
        messages: [expect.objectContaining({ id: "m8" }), expect.objectContaining({ id: "m9" })],
        latestSeq: 9,
        hasMore: true,
        cursor: "2026-01-01T00:00:08.000Z|m8",
      }],
      pageParams: [{ mode: "newest" }],
    })
    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1"))).toMatchObject({
      lastReadMessageId: "m8",
      lastReadSeq: 8,
    })
    expect(hasCoveredCommunityReplicaTarget(queryClient, "c1")).toBe(true)
    expect(hasCoveredCommunityReplicaTarget(queryClient, "c1", "m8")).toBe(true)
    expect(hasCoveredCommunityReplicaTarget(queryClient, "c1", "missing")).toBe(false)
    expect(communityReplicaMessageSearchCoverage(queryClient, "c1")).toEqual({
      completeness: "partial",
      firstSeq: 8,
      lastSeq: 9,
    })
  })

  it("keeps canonical join and creation order when numeric positions tie", () => {
    const queryClient = new QueryClient()
    const tiedProjection = {
      ...projection,
      entities: [
        ...projection.entities,
        {
          key: "server-earlier",
          scopeKey: "account:viewer",
          entity: { kind: "server", id: "z-server" },
          value: {
            ...projection.entities[0]!.value,
            id: "z-server",
            name: "Earlier server",
            joinedAt: "2025-12-31T23:59:00.000Z",
          },
        },
        {
          key: "channel-earlier",
          scopeKey: "server:s1",
          entity: { kind: "channel", id: "z-channel" },
          value: {
            ...projection.entities[2]!.value,
            id: "z-channel",
            name: "earlier channel",
            createdAt: "2025-12-31T23:59:00.000Z",
          },
        },
      ],
    } as unknown as CoveredReplicaProjection

    seedCommunityReplicaQueries(queryClient, tiedProjection)

    expect(queryClient.getQueryData<ServersResponse>(communityKeys.servers())?.servers
      .map((server) => server.id)).toEqual(["z-server", "s1"])
    expect(queryClient.getQueryData<ServerDetail>(communityKeys.server("s1"))?.categories[0]
      ?.channels.map((channel) => channel.id)).toEqual(["z-channel", "c1"])
  })

  it("refreshes canonical rows without replacing an active anchored window", () => {
    const queryClient = new QueryClient()
    const anchorPage = {
      messages: [
        { id: "m8", type: "chat", seq: 8, createdAt: "2026-01-01T00:00:08.000Z", content: "stale eight" },
        { id: "m_anchor_only", type: "chat", seq: 8.5, createdAt: "2026-01-01T00:00:08.500Z", content: "anchor only" },
      ],
      latestSeq: 9,
      hasMoreOlder: true,
      hasMoreNewer: true,
      olderCursor: "older",
      newerCursor: "newer",
    }
    queryClient.setQueryData(communityKeys.channelMessages("c1"), {
      pages: [anchorPage],
      pageParams: [{ mode: "anchor", anchor: "m_anchor_only" }],
    })

    seedCommunityReplicaQueries(queryClient, projection)

    expect(queryClient.getQueryData(communityKeys.channelMessages("c1"))).toEqual({
      pages: [{
        ...anchorPage,
        messages: [
          expect.objectContaining({ id: "m8", content: "eight" }),
          expect.objectContaining({ id: "m_anchor_only", content: "anchor only" }),
        ],
      }],
      pageParams: [{ mode: "anchor", anchor: "m_anchor_only" }],
    })
  })

  it("removes covered canonical rows without dropping unknown anchored history", () => {
    const queryClient = new QueryClient()
    const anchorPage = {
      messages: [
        { id: "m7", type: "chat", seq: 7, createdAt: "2026-01-01T00:00:07.000Z", content: "older history" },
        { id: "m8", type: "chat", seq: 8, createdAt: "2026-01-01T00:00:08.000Z", content: "deleted anchor" },
        { id: "m9", type: "chat", seq: 9, createdAt: "2026-01-01T00:00:09.000Z", content: "stale nine" },
      ],
      latestSeq: 9,
      hasMoreOlder: true,
      hasMoreNewer: true,
      olderCursor: "older",
      newerCursor: "newer",
    }
    queryClient.setQueryData(communityKeys.channelMessages("c1"), {
      pages: [anchorPage],
      pageParams: [{ mode: "anchor", anchor: "m8" }],
    })

    seedCommunityReplicaQueries(queryClient, {
      ...projection,
      entities: projection.entities.filter((row) => row.entity.id !== "m8"),
    })

    expect(queryClient.getQueryData(communityKeys.channelMessages("c1"))).toEqual({
      pages: [{
        ...anchorPage,
        messages: [
          expect.objectContaining({ id: "m7", content: "older history" }),
          expect.objectContaining({ id: "m9", content: "nine" }),
        ],
      }],
      pageParams: [{ mode: "anchor", anchor: "m8" }],
    })
  })

  it("projects a newer durable read watermark across a killed-browser reopen", () => {
    const values = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      get length() { return values.size },
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
    })
    commitCommunityReplicaReadWal("viewer", {
      channelId: "c1",
      messageId: "m9",
      seq: 9,
      observedAt: "2026-01-01T00:00:09.000Z",
    })
    const queryClient = new QueryClient()
    seedCommunityReplicaQueries(queryClient, projection)

    expect(queryClient.getQueryData(communityKeys.channelReadStateSnapshot("c1"))).toEqual({
      lastReadMessageId: "m9",
      lastReadAt: "2026-01-01T00:00:09.000Z",
      lastReadSeq: 9,
    })
    expect(listCommunityReplicaReadWal("viewer")).toHaveLength(1)

    seedCommunityReplicaQueries(queryClient, {
      ...projection,
      entities: projection.entities.map((row) => row.entity.kind === "read-state"
        ? {
            ...row,
            value: {
              channelId: "c1",
              lastReadMessageId: "m9",
              lastReadAt: "2026-01-01T00:00:09.000Z",
              lastReadSeq: 9,
            },
          }
        : row),
    })
    expect(listCommunityReplicaReadWal("viewer")).toEqual([])
  })

  it("treats a complete empty channel as covered without fabricating a message range", () => {
    const queryClient = new QueryClient()
    seedCommunityReplicaQueries(queryClient, {
      ...projection,
      frontier: [
        ...projection.frontier,
        { scope: { kind: "channel", id: "empty" }, revision: 0 },
      ],
      coverage: [
        ...projection.coverage,
        {
          scope: { kind: "channel", id: "empty" },
          revision: 0,
          completeness: "complete",
          permission: lease,
          messageRange: null,
        },
      ],
    })
    expect(queryClient.getQueryData(communityKeys.channelMessages("empty"))).toEqual({
      pages: [{ messages: [], latestSeq: 0, hasMore: false }],
      pageParams: [{ mode: "newest" }],
    })
    expect(hasCoveredCommunityReplicaTarget(queryClient, "empty")).toBe(true)
    expect(communityReplicaMessageSearchCoverage(queryClient, "empty")).toEqual({
      completeness: "complete",
      firstSeq: null,
      lastSeq: null,
    })
  })

  it("projects covered thread route metadata from its canonical parent message", () => {
    const queryClient = new QueryClient()
    seedCommunityReplicaQueries(queryClient, {
      ...projection,
      frontier: [
        ...projection.frontier,
        { scope: { kind: "channel", id: "thread-1" }, revision: 1 },
      ],
      coverage: [
        ...projection.coverage,
        {
          scope: { kind: "channel", id: "thread-1" },
          revision: 1,
          completeness: "complete",
          permission: lease,
          messageRange: { firstSeq: 1, lastSeq: 1, hasOlder: false, hasNewer: false },
        },
      ],
    })

    expect(queryClient.getQueryData(communityKeys.channelMeta("s1", "thread-1"))).toMatchObject({
      id: "thread-1",
      parentChannelId: "c1",
      parentMessageId: "m9",
      activityAt: "2026-01-01T00:00:10.000Z",
      verifiedEpoch: 0,
    })
  })

  it("merges delta coverage but resets stale channels on a new bootstrap", () => {
    const queryClient = new QueryClient()
    seedCommunityReplicaQueries(queryClient, projection)
    const nextChannel = {
      ...projection,
      frontier: [{ scope: { kind: "channel", id: "c2" }, revision: 0 }],
      coverage: [{
        scope: { kind: "channel", id: "c2" },
        revision: 0,
        completeness: "complete",
        permission: lease,
        messageRange: null,
      }],
      entities: [],
    } as CoveredReplicaProjection

    seedCommunityReplicaQueries(queryClient, nextChannel)
    expect(hasCoveredCommunityReplicaTarget(queryClient, "c1")).toBe(true)
    expect(hasCoveredCommunityReplicaTarget(queryClient, "c2")).toBe(true)

    seedCommunityReplicaQueries(queryClient, nextChannel, { resetCoverage: true })
    expect(hasCoveredCommunityReplicaTarget(queryClient, "c1")).toBe(false)
    expect(hasCoveredCommunityReplicaTarget(queryClient, "c2")).toBe(true)
  })

  it("retires revoked channel and server projections immediately", () => {
    const queryClient = new QueryClient()
    seedCommunityReplicaQueries(queryClient, projection)
    queryClient.setQueryData(communityKeys.channelRefDirectory(), [{
      id: "s1",
      name: "Alook",
      discriminator: "0001",
      channels: [{ id: "c1", name: "chat" }],
    }])
    retireCommunityReplicaQueryScopes(queryClient, [{ kind: "channel", id: "c1" }])
    expect(queryClient.getQueryData(communityKeys.channelMessages("c1"))).toBeUndefined()
    expect(hasCoveredCommunityReplicaTarget(queryClient, "c1")).toBe(false)
    expect(queryClient.getQueryData<ServerDetail>(communityKeys.server("s1"))).toMatchObject({
      categories: [{ id: "cat", channels: [] }],
      forumUnreadState: {},
      unreadSources: [],
    })
    expect(queryClient.getQueryData(communityKeys.channelRefDirectory())).toEqual([{
      id: "s1",
      name: "Alook",
      discriminator: "0001",
      channels: [],
    }])
    expect(queryClient.getQueryData<ServersResponse>(communityKeys.servers())).toMatchObject({
      servers: [{ id: "s1", unread: false, mentions: 0, unreadSources: [] }],
    })

    retireCommunityReplicaQueryScopes(queryClient, [{ kind: "server", id: "s1" }])
    expect(queryClient.getQueryData(communityKeys.server("s1"))).toBeUndefined()
    expect(queryClient.getQueryData<{ servers: Array<{ id: string }> }>(communityKeys.servers()))
      .toEqual({ servers: [] })
  })
})
