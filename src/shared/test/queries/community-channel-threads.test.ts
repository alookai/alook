import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { Database } from "../../src/db";
import {
  listChildChannels,
  listChildChannelsByParentMessageIds,
} from "../../src/db/queries/community/channel";
import { listMembers, listMembersPaginated, searchMembers } from "../../src/db/queries/community/member";
import { resolveScopeMembers, resolveScopeMemberUserIds } from "../../src/db/queries/community/members-resolver";
import { listThreadParticipants } from "../../src/db/queries/community/thread";
import { createMigratedDb } from "../helpers/migrated-db";

describe("child channel message enrichment against real SQLite", () => {
  let sqlite: Sqlite.Database;
  let db: Database;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        category_id TEXT,
        name TEXT,
        type TEXT NOT NULL DEFAULT 'text',
        topic TEXT DEFAULT '',
        position INTEGER DEFAULT 0,
        parent_channel_id TEXT,
        creator_id TEXT,
        message_count INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        parent_message_id TEXT,
        last_message_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE community_message (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL
      );
      INSERT INTO community_channel
        (id, server_id, name, type, created_at)
      VALUES
        ('parent_1', 'server_1', 'general', 'text', '2026-08-14T00:00:00.000Z');
      INSERT INTO community_message (id, content)
      VALUES ('message_1', 'Thread from a real query');
    `);
    db = drizzle(sqlite) as unknown as Database;
  });

  afterEach(() => sqlite.close());
  it("bounds message enrichment to parent and page IDs while retaining ordinary legacy types and archived indicators", async () => {
    const insert = sqlite.prepare("INSERT INTO community_channel (id, server_id, type, parent_channel_id, parent_message_id, archived, last_message_at, created_at) VALUES (?, 'server_1', ?, ?, ?, ?, ?, 'now')");
    insert.run("current", "thread", "parent_1", "page_1", 0, "3");
    insert.run("archived", "thread", "parent_1", "page_1", 1, "1");
    insert.run("legacy", "text", "parent_1", "page_2", 0, "2");
    insert.run("off_page", "thread", "parent_1", "other_message", 0, "4");
    insert.run("foreign_parent", "thread", "another_parent", "page_1", 0, "5");
    const rows = await listChildChannelsByParentMessageIds(db, "parent_1", ["page_1", "page_2"], null);
    expect(rows.map(row => row.id)).toEqual(["current", "legacy", "archived"]);
    expect((await listChildChannelsByParentMessageIds(db, "parent_1", ["page_1", "page_2"])).map(row => row.id).sort()).toEqual(["archived", "current"]);
    const select = vi.spyOn(db, "select");
    expect(await listChildChannelsByParentMessageIds(db, "parent_1", [], null)).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("paginates child channels, thread participants, scope members, and channel-excluded server rosters on migrated SQLite", async () => {
    const migrated = createMigratedDb();
    try {
      migrated.sqlite.exec(`
        INSERT INTO user (id, name, email, discriminator) VALUES
          ('u_1', 'Alice', 'u1@p.test', '0001'),
          ('u_2', 'Bob', 'u2@p.test', '0002'),
          ('u_3', 'Cara', 'u3@p.test', '0003'),
          ('u_4', 'Dan', 'u4@p.test', '0004');
        INSERT INTO community_server (id, name, discriminator, owner_id, created_at) VALUES
          ('srv_1', 'Studio', '0001', 'u_1', '2026-09-01T00:00:00Z');
        INSERT INTO community_category (id, server_id, name, position, private, creator_id) VALUES
          ('cat_priv', 'srv_1', 'Private', 0, 1, 'u_1');
        INSERT INTO community_server_member (id, server_id, user_id, role, joined_at) VALUES
          ('m_1', 'srv_1', 'u_1', 'owner', '2026-09-01T00:01:00Z'),
          ('m_2', 'srv_1', 'u_2', 'admin', '2026-09-01T00:02:00Z'),
          ('m_3', 'srv_1', 'u_3', 'member', '2026-09-01T00:03:00Z'),
          ('m_4', 'srv_1', 'u_4', 'member', '2026-09-01T00:04:00Z');
        INSERT INTO community_channel (id, server_id, category_id, name, type, creator_id, created_at) VALUES
          ('ch_pub', 'srv_1', NULL, 'general', 'text', 'u_1', '2026-09-01T00:00:00Z'),
          ('ch_priv', 'srv_1', 'cat_priv', 'secret', 'text', 'u_1', '2026-09-01T00:00:00Z');
        INSERT INTO community_channel (id, server_id, name, type, parent_channel_id, last_message_at, created_at) VALUES
          ('t_1', 'srv_1', 'T1', 'thread', 'ch_pub', '2026-09-02T00:01:00Z', '2026-09-02T00:00:00Z'),
          ('t_2', 'srv_1', 'T2', 'thread', 'ch_pub', '2026-09-02T00:02:00Z', '2026-09-02T00:00:00Z'),
          ('t_3', 'srv_1', 'T3', 'thread', 'ch_pub', '2026-09-02T00:03:00Z', '2026-09-02T00:00:00Z');
        INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES
          ('cm_priv_2', 'ch_priv', 'u_2', 'access', 'added', '2026-09-01T00:00:00Z'),
          ('cm_t1_1', 't_1', 'u_1', 'notify', 'spoke', '2026-09-02T00:00:00Z'),
          ('cm_t1_2', 't_1', 'u_2', 'notify', 'added', '2026-09-02T00:00:00Z'),
          ('cm_t1_3', 't_1', 'u_3', 'notify', 'added', '2026-09-02T00:00:00Z');
      `);

      // Child channels cursor pagination
      const page1 = await listChildChannels(migrated.db, "ch_pub", { type: "thread", limit: 2 });
      expect(page1.map((c) => c.id)).toEqual(["t_3", "t_2"]);
      const page2 = await listChildChannels(migrated.db, "ch_pub", {
        type: "thread",
        limit: 2,
        cursor: { activityAt: page1[1]!.lastMessageAt!, id: page1[1]!.id },
      });
      expect(page2.map((c) => c.id)).toEqual(["t_1"]);

      // Thread participants cursor pagination
      const p1 = await listThreadParticipants(migrated.db, "t_1", { limit: 2 });
      expect(p1.map((r) => r.userId)).toEqual(["u_1", "u_2"]);
      const p2 = await listThreadParticipants(migrated.db, "t_1", { limit: 2, cursor: p1[1]!.userId });
      expect(p2.map((r) => r.userId)).toEqual(["u_3"]);

      // Public and private scope members pagination
      const pub1 = await resolveScopeMembers(migrated.db, "ch_pub", { limit: 2 });
      expect(pub1.map((r) => r.userId)).toEqual(["u_1", "u_2"]);
      const pub2 = await resolveScopeMembers(migrated.db, "ch_pub", { limit: 2, cursor: pub1[1]!.userId });
      expect(pub2.map((r) => r.userId)).toEqual(["u_3", "u_4"]);

      const priv1 = await resolveScopeMembers(migrated.db, "ch_priv", { limit: 1 });
      expect(priv1.map((r) => r.userId)).toEqual(["u_1"]);
      const priv2 = await resolveScopeMembers(migrated.db, "ch_priv", { limit: 2, cursor: priv1[0]!.userId });
      expect(priv2.map((r) => r.userId)).toEqual(["u_2"]);
      const privIds = await resolveScopeMemberUserIds(migrated.db, "ch_priv");
      expect(privIds.sort()).toEqual(["u_1", "u_2"]);

      const allServerMembers = await listMembers(migrated.db, "srv_1");
      expect(allServerMembers.map((m) => m.userId)).toEqual(["u_1", "u_2", "u_3", "u_4"]);

      // Server-side channel exclusion on listMembersPaginated & searchMembers
      const addable = await listMembersPaginated(migrated.db, "srv_1", {
        limit: 10,
        excludeChannel: { channelId: "ch_priv", relation: "access", excludeUserId: "u_1" },
      });
      expect(addable.members.map((m) => m.userId)).toEqual(["u_3", "u_4"]);

      const searched = await searchMembers(migrated.db, "srv_1", "C", {
        limit: 10,
        excludeChannel: { channelId: "ch_priv", relation: "access", excludeUserId: "u_1" },
      });
      expect(searched.members.map((m) => m.userId)).toEqual(["u_3"]);

      const plan = migrated.sqlite
        .prepare("EXPLAIN QUERY PLAN SELECT user_id FROM community_channel_member WHERE channel_id = ? AND relation = ? ORDER BY user_id ASC")
        .all("ch_priv", "access")
        .map((row: any) => String(row.detail))
        .join(" | ");
      expect(plan).toContain("idx_channel_member_channel_relation_user");
    } finally {
      migrated.sqlite.close();
    }
  });
});
