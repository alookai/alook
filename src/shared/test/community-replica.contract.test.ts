import { describe, expect, it } from "vitest";
import {
  COMMUNITY_REPLICA_PROTOCOL_VERSION,
  communityReplicaBootstrapResponseSchema,
  communityReplicaDeltaResponseSchema,
  communityReplicaFrontierSchema,
  communityReplicaIntentRequestSchema,
  communityReplicaIntentResponseSchema,
} from "../src/community/replica";

const committedAt = "2026-09-06T03:20:00.000+08:00";
const leaseExpiresAt = "2026-09-06T04:20:00.000+08:00";
const account = { kind: "account" as const, id: "user-1" };
const channel = { kind: "channel" as const, id: "channel-1" };

describe("community Replica v1 contract", () => {
  it("rejects unknown versions, duplicate scopes, and reversed coverage", () => {
    expect(communityReplicaFrontierSchema.safeParse([
      { scope: channel, revision: 1 },
      { scope: channel, revision: 2 },
    ]).success).toBe(false);

    const snapshot = {
      protocolVersion: 2,
      snapshotId: "snapshot-1",
      takenAt: committedAt,
      frontier: [{ scope: channel, revision: 4 }],
      coverage: [{
        scope: channel,
        revision: 4,
        completeness: "partial",
        permission: { epoch: "permission-1", checkedAt: committedAt, validUntil: leaseExpiresAt },
        messageRange: { firstSeq: 8, lastSeq: 2, hasOlder: true, hasNewer: false },
      }],
      facts: [],
    };
    expect(communityReplicaBootstrapResponseSchema.safeParse(snapshot).success).toBe(false);
  });

  it("requires snapshot facts and coverage to share one reported frontier", () => {
    const valid = {
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      snapshotId: "snapshot-1",
      takenAt: committedAt,
      frontier: [
        { scope: account, revision: 2 },
        { scope: channel, revision: 7 },
      ],
      coverage: [
        {
          scope: account,
          revision: 2,
          completeness: "complete",
          permission: { epoch: "account-2", checkedAt: committedAt, validUntil: leaseExpiresAt },
          messageRange: null,
        },
        {
          scope: channel,
          revision: 7,
          completeness: "partial",
          permission: { epoch: "channel-3", checkedAt: committedAt, validUntil: leaseExpiresAt },
          messageRange: { firstSeq: 4, lastSeq: 7, hasOlder: true, hasNewer: false },
        },
      ],
      facts: [{
        scope: channel,
        entity: { kind: "message", id: "message-7" },
        value: { id: "message-7", seq: 7, content: "hello" },
      }],
    };
    expect(communityReplicaBootstrapResponseSchema.parse(valid)).toEqual(valid);

    expect(communityReplicaBootstrapResponseSchema.safeParse({
      ...valid,
      coverage: [{ ...valid.coverage[0], revision: 1 }, valid.coverage[1]],
    }).success).toBe(false);
    expect(communityReplicaBootstrapResponseSchema.safeParse({
      ...valid,
      facts: [{ ...valid.facts[0], scope: { kind: "server", id: "server-2" } }],
    }).success).toBe(false);
    expect(communityReplicaBootstrapResponseSchema.safeParse({
      ...valid,
      coverage: [{
        ...valid.coverage[0],
        permission: { ...valid.coverage[0].permission, validUntil: null },
      }, valid.coverage[1]],
    }).success).toBe(false);
    expect(communityReplicaBootstrapResponseSchema.safeParse({
      ...valid,
      coverage: [{
        ...valid.coverage[0],
        permission: { ...valid.coverage[0].permission, validUntil: committedAt },
      }, valid.coverage[1]],
    }).success).toBe(false);
  });

  it("accepts only contiguous complete causal batches", () => {
    const valid = {
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      status: "ok",
      from: [
        { scope: account, revision: 2 },
        { scope: channel, revision: 7 },
      ],
      batches: [{
        causalId: "commit-8",
        committedAt,
        deltas: [
          {
            scope: account,
            fromRevision: 2,
            toRevision: 3,
            operations: [{
              operation: "upsert",
              entity: { kind: "read-state", id: "channel-1" },
              value: { channelId: "channel-1", lastReadSeq: 8 },
            }],
          },
          {
            scope: channel,
            fromRevision: 7,
            toRevision: 8,
            operations: [{
              operation: "upsert",
              entity: { kind: "message", id: "message-8" },
              value: { id: "message-8", seq: 8 },
            }],
          },
        ],
      }],
      frontier: [
        { scope: account, revision: 3 },
        { scope: channel, revision: 8 },
      ],
      hasMore: false,
    };
    expect(communityReplicaDeltaResponseSchema.parse(valid)).toEqual(valid);

    expect(communityReplicaDeltaResponseSchema.safeParse({
      ...valid,
      batches: [{
        ...valid.batches[0],
        deltas: [{ ...valid.batches[0].deltas[1], fromRevision: 6 }],
      }],
    }).success).toBe(false);
    expect(communityReplicaDeltaResponseSchema.safeParse({
      ...valid,
      frontier: [{ scope: account, revision: 3 }, { scope: channel, revision: 7 }],
    }).success).toBe(false);
  });

  it("uses rebootstrap instead of representing a gap as an empty delta", () => {
    expect(communityReplicaDeltaResponseSchema.parse({
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      status: "rebootstrap",
      reason: "compacted",
      scopes: [channel],
    })).toEqual({
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      status: "rebootstrap",
      reason: "compacted",
      scopes: [channel],
    });
  });

  it("keeps stable intent identity and canonical outcomes distinct", () => {
    const intent = {
      intentId: "intent-1",
      kind: "message.send",
      scope: channel,
      createdAt: committedAt,
      payload: { content: "hello" },
    };
    expect(communityReplicaIntentRequestSchema.parse({
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      intents: [intent],
    }).intents[0]?.intentId).toBe("intent-1");
    expect(communityReplicaIntentRequestSchema.safeParse({
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      intents: [intent, intent],
    }).success).toBe(false);

    const accepted = {
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      outcomes: [{
        intentId: "intent-1",
        status: "accepted",
        causalId: "commit-8",
        canonical: {
          scope: channel,
          revision: 8,
          messageId: "message-8",
          seq: 8,
        },
      }],
    };
    expect(communityReplicaIntentResponseSchema.parse(accepted)).toEqual(accepted);
    expect(communityReplicaIntentResponseSchema.safeParse({
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      outcomes: [accepted.outcomes[0], accepted.outcomes[0]],
    }).success).toBe(false);
  });

  it("does not encode transport waiting as a server-side canonical outcome", () => {
    expect(communityReplicaIntentResponseSchema.safeParse({
      protocolVersion: COMMUNITY_REPLICA_PROTOCOL_VERSION,
      outcomes: [{ intentId: "intent-1", status: "transport-waiting" }],
    }).success).toBe(false);
  });
});
