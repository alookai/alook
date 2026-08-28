/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, queries } from "@alook/shared";

const runtimeEnv = env as unknown as CloudflareEnv;
const prefixes: string[] = [];

function fixturePrefix(label: string) {
  const prefix = `bind_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
  prefixes.push(prefix);
  return prefix;
}

async function run(sql: string, ...bindings: unknown[]) {
  await runtimeEnv.DB.prepare(sql).bind(...bindings).run();
}

async function runBatched(statements: D1PreparedStatement[]) {
  for (let offset = 0; offset < statements.length; offset += 50) {
    await runtimeEnv.DB.batch(statements.slice(offset, offset + 50));
  }
}

async function rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]> {
  return (await runtimeEnv.DB.prepare(sql).bind(...bindings).all<T>()).results;
}

afterEach(async () => {
  for (const prefix of prefixes.splice(0)) {
    await run("DELETE FROM community_bot_binding WHERE user_id GLOB ?", `${prefix}*`);
    await run("DELETE FROM community_machine WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM community_channel WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM community_server WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM agent_task_queue WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM conversation WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM agent WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM agent_runtime WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM workspace WHERE id GLOB ?", `${prefix}*`);
    await run("DELETE FROM user WHERE id GLOB ?", `${prefix}*`);
  }
});

describe("community high-cardinality D1 queries", () => {
  it("resolves visibility and memberships across 125 servers", async () => {
    const prefix = fixturePrefix("visibility");
    const userId = `${prefix}_user`;
    const now = "2026-08-28T00:00:00.000Z";
    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Viewer', '1000')",
      userId,
      `${userId}@example.com`,
    );

    const serverIds = Array.from({ length: 125 }, (_, index) => `${prefix}_server_${index}`);
    await runBatched(serverIds.flatMap((serverId, index) => [
      runtimeEnv.DB.prepare(
        "INSERT INTO community_server (id, name, discriminator, owner_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(serverId, `${prefix}-server-${index}`, String(index).padStart(4, "0"), userId, now),
      runtimeEnv.DB.prepare(
        "INSERT INTO community_server_member (id, server_id, user_id, role, rail_order, joined_at) VALUES (?, ?, ?, 'owner', ?, ?)",
      ).bind(`${prefix}_member_${index}`, serverId, userId, index, now),
      runtimeEnv.DB.prepare(
        "INSERT INTO community_channel (id, server_id, name, type, position, created_at) VALUES (?, ?, ?, 'text', 0, ?)",
      ).bind(`${prefix}_channel_${index}`, serverId, `general-${index}`, now),
    ]));

    const db = createDb(runtimeEnv.DB);
    const visible = await queries.communityChannel.listVisibleChannelIdsForUser(db, userId);
    expect(new Set(visible)).toEqual(new Set(serverIds.map((_, index) => `${prefix}_channel_${index}`)));
    expect(await queries.communityMember.getMemberships(db, userId, serverIds)).toHaveLength(125);
  });

  it("hydrates and reorders 125 members, categories, and reactions", async () => {
    const prefix = fixturePrefix("collections");
    const ownerId = `${prefix}_owner`;
    const serverId = `${prefix}_server`;
    const now = "2026-08-28T01:00:00.000Z";
    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Owner', '1001')",
      ownerId,
      `${ownerId}@example.com`,
    );
    await run(
      "INSERT INTO community_server (id, name, discriminator, owner_id, created_at) VALUES (?, ?, '1001', ?, ?)",
      serverId,
      `${prefix}-server`,
      ownerId,
      now,
    );

    const userIds = Array.from({ length: 125 }, (_, index) => `${prefix}_user_${index}`);
    const categoryIds = Array.from({ length: 125 }, (_, index) => `${prefix}_category_${index}`);
    const channelIds = Array.from({ length: 125 }, (_, index) => `${prefix}_channel_${index}`);
    const messageIds = Array.from({ length: 125 }, (_, index) => `${prefix}_message_${index}`);
    await runBatched(userIds.flatMap((userId, index) => [
      runtimeEnv.DB.prepare(
        "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, ?, ?)",
      ).bind(userId, `${userId}@example.com`, `Member ${index}`, String(2000 + index)),
      runtimeEnv.DB.prepare(
        "INSERT INTO community_server_member (id, server_id, user_id, role, rail_order, joined_at) VALUES (?, ?, ?, 'member', ?, ?)",
      ).bind(`${prefix}_member_${index}`, serverId, userId, index, now),
      runtimeEnv.DB.prepare(
        "INSERT INTO community_category (id, server_id, name, position, private) VALUES (?, ?, ?, ?, 0)",
      ).bind(categoryIds[index], serverId, `Category ${index}`, index),
      runtimeEnv.DB.prepare(
        "INSERT INTO community_channel (id, server_id, name, type, position, created_at) VALUES (?, ?, ?, 'text', ?, ?)",
      ).bind(channelIds[index], serverId, `channel-${index}`, index, now),
      runtimeEnv.DB.prepare(
        "INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES (?, ?, 'message', ?, ?, 1)",
      ).bind(messageIds[index], userId, now, channelIds[index]),
      runtimeEnv.DB.prepare(
        "INSERT INTO community_reaction (id, message_id, user_id, emoji, created_at) VALUES (?, ?, ?, '👍', ?)",
      ).bind(`${prefix}_reaction_${index}`, messageIds[index], ownerId, now),
    ]));

    const db = createDb(runtimeEnv.DB);
    expect(await queries.communityMember.getMembersByUserIds(db, serverId, userIds)).toHaveLength(125);
    expect(await queries.communityCategory.getCategoriesByIds(db, categoryIds)).toHaveLength(125);
    expect(await queries.communityReaction.listReactionsByMessageIds(db, messageIds, ownerId)).toHaveLength(125);

    const submitted = categoryIds.slice(0, 100).reverse();
    expect(await queries.communityCategory.reorderCategories(db, serverId, submitted)).toHaveLength(100);
    const persisted = await rows<{ id: string; position: number }>(
      "SELECT id, position FROM community_category WHERE server_id = ?",
      serverId,
    );
    const positionById = new Map(persisted.map((row) => [row.id, row.position]));
    submitted.forEach((id, index) => expect(positionById.get(id)).toBe(index));
    categoryIds.slice(100).forEach((id, index) => expect(positionById.get(id)).toBe(100 + index));

    const beforeDuplicate = new Map(positionById);
    expect(await queries.communityCategory.reorderCategories(db, serverId, [categoryIds[0], categoryIds[0]])).toEqual([]);
    const afterDuplicate = await rows<{ id: string; position: number }>(
      "SELECT id, position FROM community_category WHERE server_id = ?",
      serverId,
    );
    expect(new Map(afterDuplicate.map((row) => [row.id, row.position]))).toEqual(beforeDuplicate);
  });

  it("lists and resolves 125 DMs without dynamic IN binds", async () => {
    const prefix = fixturePrefix("dm");
    const viewerId = `${prefix}_viewer`;
    const now = "2026-08-28T02:00:00.000Z";
    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Viewer', '3000')",
      viewerId,
      `${viewerId}@example.com`,
    );
    const peerIds = Array.from({ length: 125 }, (_, index) => `${prefix}_peer_${index}`);
    await runBatched(peerIds.flatMap((peerId, index) => {
      const channelId = `${prefix}_dm_${index}`;
      return [
        runtimeEnv.DB.prepare(
          "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, ?, ?)",
        ).bind(peerId, `${peerId}@example.com`, `Peer ${index}`, String(4000 + index)),
        runtimeEnv.DB.prepare(
          "INSERT INTO community_channel (id, server_id, name, type, last_message_at, created_at) VALUES (?, NULL, NULL, 'dm', ?, ?)",
        ).bind(channelId, `2026-08-28T02:${String(index % 60).padStart(2, "0")}:00.000Z`, now),
        runtimeEnv.DB.prepare(
          "INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES (?, ?, ?, 'access', 'added', ?)",
        ).bind(`${prefix}_self_${index}`, channelId, viewerId, now),
        runtimeEnv.DB.prepare(
          "INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES (?, ?, ?, 'access', 'added', ?)",
        ).bind(`${prefix}_peer_member_${index}`, channelId, peerId, now),
      ];
    }));

    const db = createDb(runtimeEnv.DB);
    const dms = await queries.communityDm.listDMs(db, viewerId);
    expect(dms).toHaveLength(125);
    expect(new Set(dms.map((dm) => dm.otherUserId))).toEqual(new Set(peerIds));
    expect((await queries.communityDm.getDMBetween(db, viewerId, peerIds[124])).id).toBe(`${prefix}_dm_124`);
  });

  it("reconciles 125 stale bot statuses in one fixed-bind update", async () => {
    const prefix = fixturePrefix("machine");
    const ownerId = `${prefix}_owner`;
    const machineId = `${prefix}_machine`;
    const now = "2026-08-28T03:00:00.000Z";
    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Owner', '5000')",
      ownerId,
      `${ownerId}@example.com`,
    );
    await run(
      "INSERT INTO community_machine (id, user_id, display_name, hostname, available_runtimes, status, created_at, updated_at) VALUES (?, ?, 'Machine', 'host', '[]', 'online', ?, ?)",
      machineId,
      ownerId,
      now,
      now,
    );
    const botIds = Array.from({ length: 125 }, (_, index) => `${prefix}_bot_${index}`);
    await runBatched(botIds.flatMap((botId, index) => [
      runtimeEnv.DB.prepare(
        "INSERT INTO user (id, email, name, discriminator, isBot, ownerUserId) VALUES (?, ?, ?, ?, 1, ?)",
      ).bind(botId, `${botId}@example.com`, `Bot ${index}`, String(6000 + index), ownerId),
      runtimeEnv.DB.prepare(
        "INSERT INTO community_bot_binding (user_id, machine_id, runtime, instruction, created_at) VALUES (?, ?, 'codex', '', ?)",
      ).bind(botId, machineId, now),
      runtimeEnv.DB.prepare(
        "INSERT INTO community_user_profile (user_id, about_me, status_emoji, status_text) VALUES (?, '', '⚡', 'Working on it')",
      ).bind(botId),
    ]));

    const db = createDb(runtimeEnv.DB);
    expect(await queries.communityMachine.reconcileBotActivityFromRunningAgents(db, machineId, [])).toHaveLength(125);
    expect(await queries.communityMachine.reconcileBotActivityFromRunningAgents(db, machineId, [])).toEqual([]);
    expect(await rows<{ total: number }>(
      "SELECT COUNT(*) AS total FROM community_user_profile WHERE user_id GLOB ? AND status_emoji = '💤' AND status_text = 'Idle'",
      `${prefix}_bot_*`,
    )).toEqual([{ total: 125 }]);
  });

  it("hydrates 125 owned-bot friendships and DM approval cards", async () => {
    const prefix = fixturePrefix("friendship");
    const ownerId = `${prefix}_owner`;
    const now = "2026-08-28T03:30:00.000Z";
    await run(
      "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, 'Owner', '6500')",
      ownerId,
      `${ownerId}@example.com`,
    );

    const botIds = Array.from({ length: 125 }, (_, index) => `${prefix}_bot_${index}`);
    const peerIds = Array.from({ length: 125 }, (_, index) => `${prefix}_peer_${index}`);
    const friendshipIds = Array.from({ length: 125 }, (_, index) => `${prefix}_friendship_${index}`);
    const messageIds = Array.from({ length: 125 }, (_, index) => `${prefix}_approval_message_${index}`);
    await runBatched(botIds.flatMap((botId, index) => {
      const peerId = peerIds[index];
      const friendshipId = friendshipIds[index];
      const channelId = `${prefix}_approval_dm_${index}`;
      return [
        runtimeEnv.DB.prepare(
          "INSERT INTO user (id, email, name, discriminator, isBot, ownerUserId) VALUES (?, ?, ?, ?, 1, ?)",
        ).bind(botId, `${botId}@example.com`, `Bot ${index}`, String(6600 + index), ownerId),
        runtimeEnv.DB.prepare(
          "INSERT INTO user (id, email, name, discriminator) VALUES (?, ?, ?, ?)",
        ).bind(peerId, `${peerId}@example.com`, `Peer ${index}`, String(6800 + index)),
        runtimeEnv.DB.prepare(
          "INSERT INTO community_friendship (id, requester_id, addressee_id, status, needs_owner_approval, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
        ).bind(friendshipId, botId, peerId, ownerId, now, now),
        runtimeEnv.DB.prepare(
          "INSERT INTO community_channel (id, server_id, name, type, created_at) VALUES (?, NULL, NULL, 'dm', ?)",
        ).bind(channelId, now),
        runtimeEnv.DB.prepare(
          "INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES (?, ?, ?, 'access', 'added', ?)",
        ).bind(`${prefix}_approval_owner_member_${index}`, channelId, ownerId, now),
        runtimeEnv.DB.prepare(
          "INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES (?, ?, ?, 'access', 'added', ?)",
        ).bind(`${prefix}_approval_bot_member_${index}`, channelId, botId, now),
        runtimeEnv.DB.prepare(
          "INSERT INTO community_message (id, author_id, content, type, created_at, channel_id, seq, friendship_id) VALUES (?, ?, 'Approve?', 'friend_approval', ?, ?, 1, ?)",
        ).bind(messageIds[index], botId, now, channelId, friendshipId),
      ];
    }));

    const db = createDb(runtimeEnv.DB);
    expect(new Set(await queries.communityFriendship.getFriendUserIds(db, ownerId))).toEqual(new Set(botIds));
    const pending = await queries.communityFriendship.listPending(db, ownerId);
    expect(pending).toHaveLength(125);
    expect(new Set(pending.map((row) => row.id))).toEqual(new Set(friendshipIds));
    const approvals = await queries.communityFriendship.hydrateApprovalsForDmMessages(db, messageIds, ownerId);
    expect(approvals.size).toBe(125);
    expect(new Set(approvals.keys())).toEqual(new Set(messageIds));
  });
});
