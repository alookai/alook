import "fake-indexeddb/auto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { COMMUNITY_REPLICA_PROTOCOL_VERSION } from "@alook/shared"
import {
  CommunityReplicaGapError,
  applyCommunityReplicaDelta,
  applyCommunityReplicaIntentOutcomes,
  commitCommunityReplicaIntent,
  deleteCommunityReplicaAccount,
  listCommunityReplicaIntents,
  readCoveredCommunityReplica,
  replaceCommunityReplicaBootstrap,
} from "./store"

const accountId = "account-1"
const now = "2026-09-06T03:00:00.000+08:00"
const later = "2026-09-07T03:00:00.000+08:00"
const account = { kind: "account" as const, id: accountId }
const channel = { kind: "channel" as const, id: "channel-1" }

function coverage(scope: typeof account | typeof channel, revision: number) {
  return {
    scope,
    revision,
    completeness: "partial" as const,
    permission: { epoch: `${scope.kind}-lease`, checkedAt: now, validUntil: later },
    messageRange: scope.kind === "channel"
      ? { firstSeq: 1, lastSeq: 2, hasOlder: false, hasNewer: false }
      : null,
  }
}

function bootstrap() {
  return {
    protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
    snapshotId: "snapshot-1",
    takenAt: now,
    frontier: [
      { scope: account, revision: 1 },
      { scope: channel, revision: 2 },
    ],
    coverage: [coverage(account, 1), coverage(channel, 2)],
    facts: [
      {
        scope: account,
        entity: { kind: "read-state" as const, id: channel.id },
        value: { channelId: channel.id, lastReadMessageId: "message-1", lastReadAt: now, lastReadSeq: 1 },
      },
      ...[1, 2].map((seq) => ({
        scope: channel,
        entity: { kind: "message" as const, id: `message-${seq}` },
        value: { id: `message-${seq}`, type: "chat", seq, createdAt: now, content: `message ${seq}` },
      })),
    ],
  }
}

afterEach(async () => {
  await deleteCommunityReplicaAccount(accountId)
  vi.unstubAllGlobals()
})

describe("community Replica store", () => {
  it("atomically publishes only covered, unexpired scopes", async () => {
    await replaceCommunityReplicaBootstrap(accountId, bootstrap())

    const projection = await readCoveredCommunityReplica(accountId, [account, channel], Date.parse(now) + 1)
    expect(projection?.frontier.map((entry) => entry.revision)).toEqual([1, 2])
    expect(projection?.entities.map((row) => row.entity.id).sort()).toEqual([
      "channel-1",
      "message-1",
      "message-2",
    ])
    await expect(readCoveredCommunityReplica(accountId, [channel], Date.parse(later))).resolves.toBeNull()
  })

  it("applies a multi-scope causal batch without publishing a mixed frontier", async () => {
    await replaceCommunityReplicaBootstrap(accountId, bootstrap())
    await applyCommunityReplicaDelta(accountId, {
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      status: "ok",
      from: [
        { scope: account, revision: 1 },
        { scope: channel, revision: 2 },
      ],
      batches: [{
        causalId: "causal-3",
        committedAt: now,
        deltas: [
          {
            scope: account,
            fromRevision: 1,
            toRevision: 2,
            operations: [{
              operation: "upsert",
              entity: { kind: "read-state", id: channel.id },
              value: { channelId: channel.id, lastReadMessageId: "message-2", lastReadAt: now, lastReadSeq: 2 },
            }],
          },
          {
            scope: channel,
            fromRevision: 2,
            toRevision: 3,
            operations: [{
              operation: "upsert",
              entity: { kind: "message", id: "message-3" },
              value: { id: "message-3", type: "chat", seq: 3, createdAt: now, content: "message 3" },
            }],
          },
        ],
      }],
      frontier: [
        { scope: account, revision: 2 },
        { scope: channel, revision: 3 },
      ],
      hasMore: false,
    })

    const projection = await readCoveredCommunityReplica(accountId, [account, channel], Date.parse(now) + 1)
    expect(projection?.frontier.map((entry) => entry.revision)).toEqual([2, 3])
    expect(projection?.coverage.find((item) => item.scope.kind === "channel")?.messageRange?.lastSeq).toBe(3)
  })

  it("rejects a local frontier mismatch and retains the previous coherent world", async () => {
    await replaceCommunityReplicaBootstrap(accountId, bootstrap())
    const response = {
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      status: "ok",
      from: [{ scope: channel, revision: 1 }],
      batches: [{
        causalId: "wrong-base",
        committedAt: now,
        deltas: [{
          scope: channel,
          fromRevision: 1,
          toRevision: 2,
          operations: [{
            operation: "remove",
            entity: { kind: "message", id: "message-1" },
          }],
        }],
      }],
      frontier: [{ scope: channel, revision: 2 }],
      hasMore: false,
    }
    await expect(applyCommunityReplicaDelta(accountId, response)).rejects.toBeInstanceOf(CommunityReplicaGapError)
    const projection = await readCoveredCommunityReplica(accountId, [channel], Date.parse(now) + 1)
    expect(projection?.entities.map((row) => row.entity.id)).toContain("message-1")
    expect(projection?.frontier[0]?.revision).toBe(2)
  })

  it("invalidates requested scopes instead of exposing data across a rebootstrap gap", async () => {
    await replaceCommunityReplicaBootstrap(accountId, bootstrap())
    await applyCommunityReplicaDelta(accountId, {
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      status: "rebootstrap",
      reason: "permission-changed",
      scopes: [channel],
    })

    await expect(readCoveredCommunityReplica(accountId, [channel], Date.parse(now) + 1)).resolves.toBeNull()
    await expect(readCoveredCommunityReplica(accountId, [account], Date.parse(now) + 1)).resolves.not.toBeNull()
  })

  it("durably deduplicates an intent and settles it from the canonical message delta", async () => {
    const values = new Map<string, string>()
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", {
      get length() { return values.size },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    await replaceCommunityReplicaBootstrap(accountId, bootstrap())
    const intent = {
      intentId: "intent-3",
      kind: "message.send" as const,
      scope: channel,
      createdAt: now,
      payload: { content: "message 3" },
    }
    await commitCommunityReplicaIntent(accountId, intent)
    expect([...values.values()]).toEqual([JSON.stringify(intent)])
    await commitCommunityReplicaIntent(accountId, intent)
    expect(await listCommunityReplicaIntents(accountId)).toHaveLength(1)
    await applyCommunityReplicaIntentOutcomes(accountId, {
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      outcomes: [{
        intentId: intent.intentId,
        status: "accepted",
        causalId: "causal-3",
        canonical: { scope: channel, revision: 3, messageId: "message-3", seq: 3 },
      }],
    })
    await applyCommunityReplicaDelta(accountId, {
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      status: "ok",
      from: [{ scope: channel, revision: 2 }],
      batches: [{
        causalId: "causal-3",
        committedAt: now,
        deltas: [{
          scope: channel,
          fromRevision: 2,
          toRevision: 3,
          operations: [{
            operation: "upsert",
            entity: { kind: "message", id: "message-3" },
            value: { id: "message-3", type: "chat", seq: 3, createdAt: now, content: "message 3", clientNonce: intent.intentId },
          }],
        }],
      }],
      frontier: [{ scope: channel, revision: 3 }],
      hasMore: false,
    })
    expect(await listCommunityReplicaIntents(accountId)).toEqual([])
    expect(values.size).toBe(0)
  })

  it("refuses a read watermark regression", async () => {
    await replaceCommunityReplicaBootstrap(accountId, bootstrap())
    await expect(applyCommunityReplicaDelta(accountId, {
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      status: "ok",
      from: [{ scope: account, revision: 1 }],
      batches: [{
        causalId: "regression",
        committedAt: now,
        deltas: [{
          scope: account,
          fromRevision: 1,
          toRevision: 2,
          operations: [{
            operation: "upsert",
            entity: { kind: "read-state", id: channel.id },
            value: { channelId: channel.id, lastReadMessageId: "message-0", lastReadAt: now, lastReadSeq: 0 },
          }],
        }],
      }],
      frontier: [{ scope: account, revision: 2 }],
      hasMore: false,
    })).rejects.toBeInstanceOf(CommunityReplicaGapError)
  })
})
