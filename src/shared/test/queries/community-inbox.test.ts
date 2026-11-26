import { describe, it, expect, vi } from "vitest";
import { createDb } from "../../src/db";
import * as inboxQueries from "../../src/db/queries/community/inbox";
import { getAccountAttentionProjection } from "../../src/db/queries/community/attention";
import { loadUserNotificationSettingLookup } from "../../src/db/queries/community/notification-eligibility";
import { createMigratedDb } from "../helpers/migrated-db";

describe("listUnreadForumOpeners — scoped forum projection", () => {
  function createForumOpenerMock(responseSets: any[][]) {
    let call = 0;
    const select = vi.fn((fields: any) => {
      if (fields?.value) return createDb({} as any).select(fields);
      const idx = call++;
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.crossJoin = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.then = (resolve: any, reject: any) =>
        Promise.resolve(responseSets[idx] ?? []).then(resolve, reject);
      return chain;
    });
    return { select } as any;
  }

  const raw = (overrides: Partial<{
    forumChannelId: string;
    openerMessageId: string;
    openerContent: string;
    openerSeq: number;
    childChannelId: string;
    childName: string | null;
    createdAt: string;
  }> = {}) => ({
    forumChannelId: "forum_1",
    openerMessageId: "opener_1",
    openerContent: "The authoritative full opener title",
    openerSeq: 1,
    childChannelId: "post_1",
    childName: "derived truncated title",
    createdAt: "2026-07-07T10:00:00.000Z",
    ...overrides,
  });

  it("returns no rows and issues no query for an empty authorized parent scope", async () => {
    const db = createForumOpenerMock([]);
    await expect(inboxQueries.listUnreadForumOpeners(db, "u1", [])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("projects opener identity, child identity, full opener content, createdAt, and seq", async () => {
    const db = createForumOpenerMock([
      [{ id: "forum_1", serverId: "srv_1", parentChannelId: null, type: "forum", archived: 0 }],
      [],
      [raw()],
    ]);
    const result = await inboxQueries.listUnreadForumOpeners(db, "u1", ["forum_1"]);
    expect(result).toEqual([{
      forumChannelId: "forum_1",
      openerMessageId: "opener_1",
      childChannelId: "post_1",
      title: "The authoritative full opener title",
      createdAt: "2026-07-07T10:00:00.000Z",
      openerSeq: 1,
    }]);
  });

  it("falls back to the derived child name only when opener content is blank", async () => {
    const db = createForumOpenerMock([
      [{ id: "forum_1", serverId: "srv_1", parentChannelId: null, type: "forum", archived: 0 }],
      [],
      [
        raw({ openerMessageId: "blank", openerContent: "  ", childName: "Fallback title" }),
        raw({ openerMessageId: "full", openerContent: "  preserve me  ", childName: "Wrong" }),
      ],
    ]);
    const result = await inboxQueries.listUnreadForumOpeners(db, "u1", ["forum_1"]);
    expect(Object.fromEntries(result.map((row) => [row.openerMessageId, row.title]))).toEqual({
      blank: "Fallback title",
      full: "  preserve me  ",
    });
  });

  it("uses one authorized set predicate and globally sorts createdAt, seq, then id", async () => {
    const firstChunk = [
      raw({ openerMessageId: "opener_a", openerSeq: 4, createdAt: "2026-07-07T10:00:00.000Z" }),
      raw({ openerMessageId: "opener_z", openerSeq: 8, createdAt: "2026-07-07T09:00:00.000Z" }),
    ];
    const secondChunk = [
      raw({ openerMessageId: "opener_b", openerSeq: 5, createdAt: "2026-07-07T10:00:00.000Z" }),
      raw({ openerMessageId: "opener_c", openerSeq: 5, createdAt: "2026-07-07T10:00:00.000Z" }),
    ];
    const ids = Array.from({ length: 91 }, (_, i) => `forum_${i}`);
    const db = createForumOpenerMock([
      ids.map((id) => ({ id, serverId: "srv_1", parentChannelId: null, type: "forum", archived: 0 })),
      [],
      [...firstChunk, ...secondChunk],
    ]);
    const result = await inboxQueries.listUnreadForumOpeners(db, "u1", ids);

    // 1 metadata query + 1 settings query + 1 forum-opener query (+ 2 jsonTextSet subqueries)
    expect(result.map((row) => row.openerMessageId)).toEqual([
      "opener_c",
      "opener_b",
      "opener_a",
      "opener_z",
    ]);
  });
});

describe("listThreadOpenersByChildIds — child projection mapping", () => {
  function createChildOpenerMock(responseSets: any[][]) {
    let call = 0;
    const chain: any = {};
    chain.select = vi.fn((fields: any) => fields?.value ? createDb({} as any).select(fields) : chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(responseSets[call++] ?? []));
    return chain;
  }

  const raw = (overrides: Record<string, unknown> = {}) => ({
    parentChannelId: "parent_1",
    parentServerId: "srv_1",
    parentParentChannelId: null,
    parentType: "text",
    openerMessageId: "opener_1",
    openerContent: "Canonical title",
    openerSeq: 7,
    childChannelId: "post_1",
    childName: "derived",
    createdAt: "2026-07-07T10:00:00.000Z",
    rawUnread: 1,
    hasAttention: 0,
    ...overrides,
  });

  it("does not query for an empty authorized child scope", async () => {
    const db = createChildOpenerMock([]);
    await expect(inboxQueries.listThreadOpenersByChildIds(db, "u1", [])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns full canonical content and falls back only for blank content", async () => {
    const db = createChildOpenerMock([
      [
        raw(),
        raw({ openerMessageId: "blank", childChannelId: "post_2", openerContent: "  ", childName: "Fallback", rawUnread: 0 }),
      ],
      [],
    ]);
    const rows = await inboxQueries.listThreadOpenersByChildIds(db, "u1", ["post_1", "post_2"]);
    expect(rows.map((row) => [row.childChannelId, row.title])).toEqual([
      ["post_1", "Canonical title"],
      ["post_2", "Fallback"],
    ]);
    expect(rows[0]).toMatchObject({
      parentChannelId: "parent_1",
      parentType: "text",
      openerSeq: 7,
      openerUnread: true,
    });
    expect(rows[1]?.openerUnread).toBe(false);
  });

  it("uses one child set predicate and globally sorts results", async () => {
    const db = createChildOpenerMock([
      [
        raw({ openerMessageId: "older", childChannelId: "post_old", createdAt: "2026-07-07T09:00:00.000Z" }),
        raw({ openerMessageId: "newer", childChannelId: "post_new", createdAt: "2026-07-07T11:00:00.000Z" }),
      ],
      [],
    ]);
    const ids = Array.from({ length: 91 }, (_, index) => `post_${index}`);
    const rows = await inboxQueries.listThreadOpenersByChildIds(db, "u1", ids, {
      settings: { byChannelId: new Map(), byServerId: new Map() },
    });
    expect(db.where).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => row.openerMessageId)).toEqual(["newer", "older"]);
  });
});

describe("migrated SQLite hot indexes and preloaded notification settings", () => {
  it("uses non-partial idx_message_channel_seq for exact seq and COALESCE unread range lookups", () => {
    const { sqlite } = createMigratedDb();
    try {
      const exactPlan = sqlite
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM community_message WHERE channel_id = ? AND seq = ?")
        .all("ch_1", 42)
        .map((row: any) => String(row.detail))
        .join(" | ");
      expect(exactPlan).toContain("idx_message_channel_seq");

      const rangePlan = sqlite
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM community_message WHERE channel_id = ? AND seq > COALESCE(?, 0)")
        .all("ch_1", null)
        .map((row: any) => String(row.detail))
        .join(" | ");
      expect(rangePlan).toContain("idx_message_channel_seq");
    } finally {
      sqlite.close();
    }
  });

  it("applies preloaded notification policies across channels, DMs, forum openers, and thread openers on migrated SQLite", async () => {
    const { db, sqlite } = createMigratedDb();
    try {
      sqlite.exec(`
        INSERT INTO user (id, name, email, discriminator) VALUES
          ('viewer', 'Viewer', 'viewer@inbox.test', '0001'),
          ('alice', 'Alice', 'alice@inbox.test', '0002'),
          ('bob', 'Bob', 'bob@inbox.test', '0003');
        INSERT INTO community_server (id, name, discriminator, owner_id, created_at) VALUES
          ('srv_1', 'Studio', '0001', 'alice', '2026-09-01T00:00:00Z');
        INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES
          ('sm_1', 'srv_1', 'viewer', 'member', '2026-09-01T00:00:00Z'),
          ('sm_2', 'srv_1', 'alice', 'owner', '2026-09-01T00:00:00Z');
        INSERT INTO community_channel (id, server_id, name, type, parent_channel_id, parent_message_id, archived, created_at) VALUES
          ('ch_all', 'srv_1', 'general', 'text', NULL, NULL, 0, '2026-09-01T00:00:00Z'),
          ('ch_mentions', 'srv_1', 'alerts', 'text', NULL, NULL, 0, '2026-09-01T00:00:00Z'),
          ('ch_muted', 'srv_1', 'muted', 'text', NULL, NULL, 0, '2026-09-01T00:00:00Z'),
          ('forum_1', 'srv_1', 'ideas', 'forum', NULL, NULL, 0, '2026-09-01T00:00:00Z'),
          ('dm_all', NULL, NULL, 'dm', NULL, NULL, 0, '2026-09-01T00:00:00Z'),
          ('dm_muted', NULL, NULL, 'dm', NULL, NULL, 0, '2026-09-01T00:00:00Z');
        INSERT INTO community_message (id, author_id, channel_id, seq, content, created_at) VALUES
          ('m_all', 'alice', 'ch_all', 1, 'hello', '2026-09-02T00:00:00Z'),
          ('m_mentions_plain', 'alice', 'ch_mentions', 1, 'plain', '2026-09-02T00:00:00Z'),
          ('m_mentions_hit', 'alice', 'ch_mentions', 2, 'ping', '2026-09-02T00:01:00Z'),
          ('m_muted', 'alice', 'ch_muted', 1, 'ignored', '2026-09-02T00:00:00Z'),
          ('m_opener_1', 'alice', 'forum_1', 1, 'First post', '2026-09-02T00:01:00Z'),
          ('m_opener_2', 'alice', 'forum_1', 2, 'Second post', '2026-09-02T00:02:00Z'),
          ('m_opener_3', 'alice', 'forum_1', 3, 'Third post', '2026-09-02T00:03:00Z'),
          ('m_dm_all', 'alice', 'dm_all', 1, 'hey', '2026-09-02T00:00:00Z'),
          ('m_dm_muted', 'bob', 'dm_muted', 1, 'quiet', '2026-09-02T00:00:00Z');
        INSERT INTO community_channel (id, server_id, name, type, parent_channel_id, parent_message_id, archived, created_at) VALUES
          ('post_1', 'srv_1', 'First post', 'thread', 'forum_1', 'm_opener_1', 0, '2026-09-02T00:01:00Z'),
          ('post_2', 'srv_1', 'Second post', 'thread', 'forum_1', 'm_opener_2', 0, '2026-09-02T00:02:00Z'),
          ('post_3', 'srv_1', 'Third post', 'thread', 'forum_1', 'm_opener_3', 0, '2026-09-02T00:03:00Z'),
          ('thread_unjoined', 'srv_1', 'Unjoined', 'thread', 'ch_all', 'm_all', 0, '2026-09-02T00:04:00Z');
        INSERT INTO community_message (id, author_id, channel_id, seq, content, created_at) VALUES
          ('m_unjoined', 'alice', 'thread_unjoined', 1, 'not subscribed', '2026-09-02T00:05:00Z');
        INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES
          ('cm_dm1_v', 'dm_all', 'viewer', 'access', 'added', '2026-09-01T00:00:00Z'),
          ('cm_dm1_a', 'dm_all', 'alice', 'access', 'added', '2026-09-01T00:00:00Z'),
          ('cm_dm2_v', 'dm_muted', 'viewer', 'access', 'added', '2026-09-01T00:00:00Z'),
          ('cm_dm2_b', 'dm_muted', 'bob', 'access', 'added', '2026-09-01T00:00:00Z');
        INSERT INTO community_mention (id, message_id, user_id, kind, read) VALUES
          ('men_1', 'm_mentions_hit', 'viewer', 'mention', 0),
          ('men_muted', 'm_muted', 'viewer', 'mention', 0);
        INSERT INTO community_notification_setting (id, user_id, server_id, channel_id, level) VALUES
          ('ns_1', 'viewer', NULL, 'ch_mentions', 'mentions'),
          ('ns_2', 'viewer', NULL, 'ch_muted', 'nothing'),
          ('ns_3', 'viewer', NULL, 'dm_muted', 'nothing');
      `);

      const settings = await loadUserNotificationSettingLookup(db, "viewer");
      const channels = await inboxQueries.listEligibleUnreadChannels(
        db,
        "viewer",
        ["ch_all", "ch_mentions", "ch_muted", "forum_1", "thread_unjoined"],
        { settings },
      );
      expect(channels.map((row) => row.channelId).sort()).toEqual(["ch_all", "ch_mentions", "forum_1"]);
      expect(channels.find((row) => row.channelId === "ch_mentions")?.unreadCount).toBe(1);

      const dms = await inboxQueries.listEligibleUnreadDms(db, "viewer", { settings });
      expect(dms.map((row) => row.channelId)).toEqual(["dm_all"]);

      const openersCapped = await inboxQueries.listUnreadForumOpeners(db, "viewer", ["forum_1"], { limit: 2, settings });
      expect(openersCapped.map((row) => row.openerMessageId)).toEqual(["m_opener_3", "m_opener_2"]);

      const threadOpeners = await inboxQueries.listThreadOpenersByChildIds(db, "viewer", ["post_1"], { settings });
      expect(threadOpeners).toHaveLength(1);
      expect(threadOpeners[0]).toMatchObject({ childChannelId: "post_1", openerUnread: true });

      const attention = await getAccountAttentionProjection(db, "viewer", 2);
      expect(attention.truncated).toBe(true);
      expect(attention.items.filter((item) => item.kind === "forum_post")).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });
});
