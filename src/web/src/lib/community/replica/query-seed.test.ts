import { describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { CoveredReplicaProjection } from "./store"
import { hasCoveredCommunityReplicaTarget, seedCommunityReplicaQueries } from "./query-seed"

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
    { key: "server", scopeKey: "account:viewer", entity: { kind: "server", id: "s1" }, value: { id: "s1", name: "Alook", discriminator: "0001", description: "desc", ownerId: "owner", icon: null, initial: "A", isOwner: false, railOrder: 0, unread: true, mentions: 1, unreadSources: [{ channelId: "c1", lastUnreadSeq: 9 }], mentionSources: [] } },
    { key: "category", scopeKey: "server:s1", entity: { kind: "category", id: "cat" }, value: { id: "cat", serverId: "s1", name: "General", position: 0, private: false, creatorId: null } },
    { key: "channel", scopeKey: "server:s1", entity: { kind: "channel", id: "c1" }, value: { id: "c1", serverId: "s1", categoryId: "cat", name: "chat", position: 0, type: "text", creatorId: null } },
    { key: "unread", scopeKey: "server:s1", entity: { kind: "unread-source", id: "c1" }, value: { channelId: "c1", serverId: "s1", parentChannelId: null, lastUnreadSeq: 9, lastAttentionSeq: null } },
    { key: "read", scopeKey: "account:viewer", entity: { kind: "read-state", id: "c1" }, value: { channelId: "c1", lastReadMessageId: "m8", lastReadAt: "2026-01-01T00:00:08.000Z", lastReadSeq: 8 } },
    { key: "m8", scopeKey: "channel:c1", entity: { kind: "message", id: "m8" }, value: { id: "m8", type: "chat", seq: 8, createdAt: "2026-01-01T00:00:08.000Z", content: "eight" } },
    { key: "m9", scopeKey: "channel:c1", entity: { kind: "message", id: "m9" }, value: { id: "m9", type: "chat", seq: 9, createdAt: "2026-01-01T00:00:09.000Z", content: "nine" } },
  ],
} as unknown as CoveredReplicaProjection

describe("community Replica query seed", () => {
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
  })
})
