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
    const coveredScopes = [
      { kind: "account" as const, id: f.userId },
      { kind: "server" as const, id: f.serverId },
      { kind: "channel" as const, id: f.channelId },
    ];
    const before = await queries.communityReplicaStore.getReplicaScopeRevisions(f.db, coveredScopes);
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
    await expect(queries.communityReplicaStore.getReplicaScopeRevisions(f.db, coveredScopes))
      .resolves.toEqual(before);
    expect(await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "channel", id: f.channelId },
      0,
      10,
    )).toEqual([]);
  });

  it("advances account, server, thread, and parent frontiers with shared message causality", async () => {
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
      { kind: "account", id: f.userId },
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
      { kind: "account", id: f.userId },
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

    expect(afterRevision.get(`account:${f.userId}`)).toBe(
      (beforeRevision.get(`account:${f.userId}`) ?? 0) + 2,
    );
    expect(afterRevision.get(`server:${f.serverId}`)).toBe(
      (beforeRevision.get(`server:${f.serverId}`) ?? 0) + 2,
    );
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
    const accountDeltas = await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "account", id: f.userId },
      beforeRevision.get(`account:${f.userId}`) ?? 0,
      10,
    );
    const serverDeltas = await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "server", id: f.serverId },
      beforeRevision.get(`server:${f.serverId}`) ?? 0,
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
    expect(accountDeltas).toContainEqual(expect.objectContaining({
      causalId: `message:${replyId}`,
      descriptor: { kind: "server-refresh", serverId: f.serverId },
    }));
    expect(serverDeltas).toContainEqual(expect.objectContaining({
      causalId: `message:${replyId}`,
      descriptor: { kind: "unread-source-refresh", channelId: threadId },
    }));
  });

  it("journals private-channel membership into the server and affected account with one causal id", async () => {
    const f = await fixture();
    const guestId = `${f.prefix}_guest`;
    const categoryId = `${f.prefix}_private`;
    const memberId = `${f.prefix}_guest_member`;
    const channelMemberId = `${f.prefix}_channel_member`;
    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Replica Guest', '1001')",
      guestId,
      `${guestId}@example.com`,
    );
    await run(
      "INSERT INTO community_server_member (id, server_id, user_id, role, rail_order, joined_at) VALUES (?, ?, ?, 'member', 1, ?)",
      memberId,
      f.serverId,
      guestId,
      f.now,
    );
    await run(
      "INSERT INTO community_category (id, server_id, name, position, private, creator_id) VALUES (?, ?, 'Private', 0, 1, ?)",
      categoryId,
      f.serverId,
      f.userId,
    );
    await run("UPDATE community_channel SET category_id = ? WHERE id = ?", categoryId, f.channelId);
    const scopes = [
      { kind: "account" as const, id: guestId },
      { kind: "server" as const, id: f.serverId },
    ];
    const before = await queries.communityReplicaStore.getReplicaScopeRevisions(f.db, scopes);
    const beforeByScope = new Map(before.map((row) => [`${row.scope.kind}:${row.scope.id}`, row.revision]));
    await expect(queries.communityReplicaDelta.loadReplicaChannels(
      f.db,
      guestId,
      f.serverId,
      [f.channelId],
    )).resolves.toEqual([]);

    await run(
      "INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_by, added_at) VALUES (?, ?, ?, 'access', 'added', ?, ?)",
      channelMemberId,
      f.channelId,
      guestId,
      f.userId,
      f.now,
    );

    const accountDeltas = await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "account", id: guestId },
      beforeByScope.get(`account:${guestId}`) ?? 0,
      10,
    );
    const serverDeltas = await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "server", id: f.serverId },
      beforeByScope.get(`server:${f.serverId}`) ?? 0,
      10,
    );
    expect(accountDeltas).toEqual([
      expect.objectContaining({
        causalId: `channel-member:${channelMemberId}`,
        descriptor: { kind: "server-refresh", serverId: f.serverId },
      }),
    ]);
    expect(serverDeltas).toEqual([
      expect.objectContaining({
        causalId: `channel-member:${channelMemberId}`,
        descriptor: { kind: "channel-refresh", channelId: f.channelId },
      }),
    ]);
    await expect(queries.communityReplicaDelta.readReplicaDeltaWindow(f.db, before, 10))
      .resolves.toMatchObject({ status: "ok", hasMore: false });
    await expect(queries.communityReplicaDelta.loadReplicaChannels(
      f.db,
      guestId,
      f.serverId,
      [f.channelId],
    )).resolves.toEqual([expect.objectContaining({ id: f.channelId })]);

    const afterInsert = await queries.communityReplicaStore.getReplicaScopeRevisions(f.db, scopes);
    const afterInsertByScope = new Map(afterInsert.map((row) => [
      `${row.scope.kind}:${row.scope.id}`,
      row.revision,
    ]));
    await run("DELETE FROM community_channel_member WHERE id = ?", channelMemberId);
    await expect(queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "account", id: guestId },
      afterInsertByScope.get(`account:${guestId}`) ?? 0,
      10,
    )).resolves.toEqual([
      expect.objectContaining({
        causalId: `channel-member-delete:${channelMemberId}`,
        descriptor: { kind: "server-refresh", serverId: f.serverId },
      }),
    ]);
    await expect(queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "server", id: f.serverId },
      afterInsertByScope.get(`server:${f.serverId}`) ?? 0,
      10,
    )).resolves.toEqual([
      expect.objectContaining({
        causalId: `channel-member-delete:${channelMemberId}`,
        descriptor: { kind: "channel-refresh", channelId: f.channelId },
      }),
    ]);
    await expect(queries.communityReplicaDelta.loadReplicaChannels(
      f.db,
      guestId,
      f.serverId,
      [f.channelId],
    )).resolves.toEqual([]);
  });

  it("keeps every scope revision contiguous with an entity-specific delta", async () => {
    const f = await fixture();
    const messageId = `${f.prefix}_coverage_message`;
    const categoryId = `${f.prefix}_coverage_category`;
    await run(
      "INSERT INTO community_category (id, server_id, name, position, private, creator_id) VALUES (?, ?, 'Coverage', 1, 0, ?)",
      categoryId,
      f.serverId,
      f.userId,
    );
    const beforePrivacy = await queries.communityReplicaStore.getReplicaScopeRevisions(f.db, [
      { kind: "account", id: f.userId },
      { kind: "server", id: f.serverId },
    ]);
    await run("UPDATE community_category SET private = 1 WHERE id = ?", categoryId);
    const accountBeforePrivacy = beforePrivacy.find((row) => row.scope.kind === "account")!.revision;
    const serverBeforePrivacy = beforePrivacy.find((row) => row.scope.kind === "server")!.revision;
    const accountPrivacy = await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "account", id: f.userId },
      accountBeforePrivacy,
      10,
    );
    const serverPrivacy = await queries.communityReplicaStore.listReplicaDeltaRows(
      f.db,
      { kind: "server", id: f.serverId },
      serverBeforePrivacy,
      10,
    );
    expect(accountPrivacy).toEqual([
      expect.objectContaining({
        causalId: `category-update:${categoryId}:${serverBeforePrivacy + 1}`,
        descriptor: { kind: "server-refresh", serverId: f.serverId },
      }),
    ]);
    expect(serverPrivacy).toEqual([
      expect.objectContaining({
        causalId: `category-update:${categoryId}:${serverBeforePrivacy + 1}`,
        descriptor: { kind: "category-refresh", categoryId, reconcileChannels: true },
      }),
    ]);
    await queries.communityMessage.createMessage(f.db, {
      id: messageId,
      authorId: f.userId,
      authorKind: "human",
      content: "coverage",
      channelId: f.channelId,
    });
    await run(
      "INSERT INTO community_mention (id, message_id, user_id, kind, read) VALUES (?, ?, ?, 'mention', 0)",
      `${f.prefix}_mention`,
      messageId,
      f.userId,
    );

    const coverage = await runtimeEnv.DB.prepare(
      `SELECT scope.scope_kind AS scopeKind, scope.scope_id AS scopeId,
              scope.revision AS revision, COUNT(delta.revision) AS deltaCount,
              MIN(delta.revision) AS firstRevision, MAX(delta.revision) AS lastRevision
       FROM community_replica_scope_revision AS scope
       LEFT JOIN community_replica_delta AS delta
         ON delta.scope_kind = scope.scope_kind AND delta.scope_id = scope.scope_id
       WHERE scope.scope_id IN (?, ?, ?)
       GROUP BY scope.scope_kind, scope.scope_id, scope.revision`,
    ).bind(f.userId, f.serverId, f.channelId).all<{
      scopeKind: string;
      scopeId: string;
      revision: number;
      deltaCount: number;
      firstRevision: number;
      lastRevision: number;
    }>();
    expect(coverage.results.length).toBe(3);
    for (const row of coverage.results) {
      expect(row.deltaCount, `${row.scopeKind}:${row.scopeId}`).toBe(row.revision);
      expect(row.firstRevision).toBe(1);
      expect(row.lastRevision).toBe(row.revision);
    }
  });

  it("hydrates bounded descriptor id sets without crossing D1's bind limit", async () => {
    const f = await fixture();
    const messageId = `${f.prefix}_bounded_message`;
    await queries.communityMessage.createMessage(f.db, {
      id: messageId,
      authorId: f.userId,
      authorKind: "human",
      content: "bounded",
      channelId: f.channelId,
    });
    const channelIds = [
      f.channelId,
      ...Array.from({ length: 149 }, (_, index) => `${f.prefix}_missing_channel_${index}`),
    ];
    const serverIds = [
      f.serverId,
      ...Array.from({ length: 149 }, (_, index) => `${f.prefix}_missing_server_${index}`),
    ];

    await expect(queries.communityReplicaDelta.loadReplicaReadStates(
      f.db,
      f.userId,
      channelIds,
    )).resolves.toEqual([expect.objectContaining({ channelId: f.channelId })]);
    await expect(queries.communityReplicaDelta.loadReplicaChannels(
      f.db,
      f.userId,
      f.serverId,
      channelIds,
    )).resolves.toEqual([expect.objectContaining({ id: f.channelId })]);
    await expect(queries.communityReplicaDelta.loadReplicaUnreadSources(
      f.db,
      f.userId,
      f.serverId,
      channelIds,
    )).resolves.toEqual([expect.objectContaining({ channelId: f.channelId })]);
    await expect(queries.communityReplicaDelta.loadReplicaAccountServers(
      f.db,
      f.userId,
      serverIds,
    )).resolves.toEqual([expect.objectContaining({ id: f.serverId })]);
  });
});
