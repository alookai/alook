/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, queries } from "@alook/shared";

const runtimeEnv = env as unknown as CloudflareEnv;
const prefixes: string[] = [];

async function run(statement: string, ...bindings: unknown[]) {
  await runtimeEnv.DB.prepare(statement).bind(...bindings).run();
}

async function first<T>(statement: string, ...bindings: unknown[]): Promise<T | null> {
  return runtimeEnv.DB.prepare(statement).bind(...bindings).first<T>();
}

async function fixture() {
  const prefix = `replica_${crypto.randomUUID().replaceAll("-", "")}`;
  prefixes.push(prefix);
  const userId = `${prefix}_user`;
  const serverId = `${prefix}_server`;
  const channelId = `${prefix}_channel`;
  const now = "2026-09-06T00:00:00.000Z";
  await run(
    "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Replica User', '1000')",
    userId,
    `${userId}@example.com`,
  );
  await run(
    "INSERT INTO community_server (id, name, discriminator, owner_id, created_at) VALUES (?, 'Replica', '1000', ?, ?)",
    serverId,
    userId,
    now,
  );
  await run(
    "INSERT INTO community_server_member (id, server_id, user_id, role, rail_order, joined_at) VALUES (?, ?, ?, 'owner', 0, ?)",
    `${prefix}_member`,
    serverId,
    userId,
    now,
  );
  await run(
    "INSERT INTO community_channel (id, server_id, name, type, position, created_at) VALUES (?, ?, 'general', 'text', 0, ?)",
    channelId,
    serverId,
    now,
  );
  return { prefix, userId, serverId, channelId, now, db: createDb(runtimeEnv.DB) };
}

afterEach(async () => {
  for (const prefix of prefixes.splice(0)) {
    await run("DELETE FROM community_server WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM user WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM community_replica_delta WHERE scope_id GLOB ?", `${prefix}*`);
    await run("DELETE FROM community_replica_scope_revision WHERE scope_id GLOB ?", `${prefix}*`);
  }
});

describe("Replica real D1 commit boundary", () => {
  it("commits one message, revision delta, and terminal accepted outcome atomically", async () => {
    const f = await fixture();
    const intentId = `${f.prefix}_intent`;
    const messageId = `${f.prefix}_message`;
    const outcomeStatement = queries.communityReplicaStore.acceptReplicaTextIntentBuilder(f.db, {
      actorId: f.userId,
      intentId,
      requestHash: "hash-1",
      channelId: f.channelId,
      status: "accepted",
      now: f.now,
    });

    const message = await queries.communityMessage.createMessage(f.db, {
      id: messageId,
      authorId: f.userId,
      authorKind: "human",
      content: "hello",
      channelId: f.channelId,
      clientNonce: intentId,
      extraStatements: [outcomeStatement],
    });
    const outcome = await queries.communityReplicaStore.getReplicaIntent(f.db, f.userId, intentId);
    const channelFrontier = await queries.communityReplicaStore.getReplicaScopeRevisions(
      f.db,
      [{ kind: "channel", id: f.channelId }],
    );
    const deltas = await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "channel", id: f.channelId },
      0,
      10,
    );

    expect(message).toMatchObject({ id: messageId, seq: 1, clientNonce: intentId });
    expect(outcome).toMatchObject({
      status: "accepted",
      causalId: `message:${messageId}`,
      messageId,
      seq: 1,
      revision: channelFrontier[0]?.revision,
    });
    expect(deltas).toEqual([
      expect.objectContaining({
        scopeKind: "channel",
        scopeId: f.channelId,
        revision: channelFrontier[0]?.revision,
        causalId: `message:${messageId}`,
        descriptor: { kind: "message-upsert", messageId },
      }),
    ]);
  });

  it("rolls back the message, sequence, revision, and delta when the outcome insert fails", async () => {
    const f = await fixture();
    const intentId = `${f.prefix}_intent`;
    const messageId = `${f.prefix}_message`;
    await queries.communityReplicaStore.rejectReplicaTextIntent(f.db, {
      actorId: f.userId,
      intentId,
      requestHash: "old-hash",
      channelId: f.channelId,
      code: "conflict",
      reason: "occupied",
      now: f.now,
    });
    const before = await queries.communityReplicaStore.getReplicaScopeRevisions(
      f.db,
      [{ kind: "channel", id: f.channelId }],
    );
    const outcomeStatement = queries.communityReplicaStore.acceptReplicaTextIntentBuilder(f.db, {
      actorId: f.userId,
      intentId,
      requestHash: "new-hash",
      channelId: f.channelId,
      status: "accepted",
      now: f.now,
    });

    await expect(queries.communityMessage.createMessage(f.db, {
      id: messageId,
      authorId: f.userId,
      authorKind: "human",
      content: "must rollback",
      channelId: f.channelId,
      clientNonce: intentId,
      extraStatements: [outcomeStatement],
    })).rejects.toThrow();

    expect(await first("SELECT id FROM community_message WHERE id = ?", messageId)).toBeNull();
    expect(await first("SELECT next_seq FROM community_message_seq WHERE channel_id = ?", f.channelId)).toBeNull();
    await expect(queries.communityReplicaStore.getReplicaScopeRevisions(
      f.db,
      [{ kind: "channel", id: f.channelId }],
    )).resolves.toEqual(before);
    expect(await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "channel", id: f.channelId },
      0,
      10,
    )).toEqual([]);
  });

  it("keeps message activity out of the server frontier and advances the thread parent causally", async () => {
    const f = await fixture();
    const openerId = `${f.prefix}_opener`;
    const threadId = `${f.prefix}_thread`;
    const replyId = `${f.prefix}_reply`;

    await queries.communityMessage.createMessage(f.db, {
      id: openerId,
      authorId: f.userId,
      authorKind: "human",
      content: "thread opener",
      channelId: f.channelId,
    });
    await run(
      `INSERT INTO community_channel
        (id, server_id, name, type, parent_channel_id, creator_id, parent_message_id, created_at)
       VALUES (?, ?, 'Thread', 'thread', ?, ?, ?, ?)`,
      threadId,
      f.serverId,
      f.channelId,
      f.userId,
      openerId,
      f.now,
    );

    const before = await queries.communityReplicaStore.getReplicaScopeRevisions(f.db, [
      { kind: "server", id: f.serverId },
      { kind: "channel", id: f.channelId },
      { kind: "channel", id: threadId },
    ]);
    await queries.communityMessage.createMessage(f.db, {
      id: replyId,
      authorId: f.userId,
      authorKind: "human",
      content: "thread reply",
      channelId: threadId,
    });
    const after = await queries.communityReplicaStore.getReplicaScopeRevisions(f.db, [
      { kind: "server", id: f.serverId },
      { kind: "channel", id: f.channelId },
      { kind: "channel", id: threadId },
    ]);
    const revisions = (rows: typeof before) => new Map(rows.map((row) => [
      `${row.scope.kind}:${row.scope.id}`,
      row.revision,
    ]));
    const beforeRevision = revisions(before);
    const afterRevision = revisions(after);

    expect(afterRevision.get(`server:${f.serverId}`)).toBe(beforeRevision.get(`server:${f.serverId}`));
    expect(afterRevision.get(`channel:${f.channelId}`)).toBe(
      (beforeRevision.get(`channel:${f.channelId}`) ?? 0) + 1,
    );
    expect(afterRevision.get(`channel:${threadId}`)).toBe(1);

    const parentDeltas = await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "channel", id: f.channelId },
      beforeRevision.get(`channel:${f.channelId}`) ?? 0,
      10,
    );
    const threadDeltas = await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "channel", id: threadId },
      0,
      10,
    );
    expect(parentDeltas).toEqual([
      expect.objectContaining({
        causalId: `message:${replyId}`,
        descriptor: { kind: "message-upsert", messageId: openerId },
      }),
    ]);
    expect(threadDeltas).toEqual([
      expect.objectContaining({
        causalId: `message:${replyId}`,
        descriptor: { kind: "message-upsert", messageId: replyId },
      }),
    ]);
  });
});
