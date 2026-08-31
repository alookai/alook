import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  deleteChannelMemberAndChildParticipants,
  deleteThreadParticipantWithCreatorHandoff,
} from "../../src/db/queries/community/channel";
import { removeMemberAndOwnerBots } from "../../src/db/queries/community/member";

function createDatabase() {
  const sqlite = new Sqlite(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE community_server (id TEXT PRIMARY KEY);
    CREATE TABLE community_server_member (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      rail_order INTEGER DEFAULT 0,
      joined_at TEXT NOT NULL
    );
    CREATE TABLE community_server_folder (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0
    );
    CREATE TABLE community_server_folder_item (
      folder_id TEXT NOT NULL REFERENCES community_server_folder(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
      position INTEGER DEFAULT 0,
      PRIMARY KEY(folder_id, server_id)
    );
    CREATE TABLE community_category (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      position INTEGER DEFAULT 0,
      private INTEGER DEFAULT 0,
      creator_id TEXT
    );
    CREATE TABLE community_channel (
      id TEXT PRIMARY KEY,
      server_id TEXT REFERENCES community_server(id) ON DELETE CASCADE,
      category_id TEXT REFERENCES community_category(id) ON DELETE SET NULL,
      name TEXT,
      type TEXT NOT NULL DEFAULT 'text',
      topic TEXT DEFAULT '',
      position INTEGER DEFAULT 0,
      parent_channel_id TEXT REFERENCES community_channel(id) ON DELETE CASCADE,
      creator_id TEXT,
      message_count INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      parent_message_id TEXT,
      last_message_at TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE community_channel_member (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'access',
      source TEXT NOT NULL DEFAULT 'added',
      added_by TEXT,
      added_at TEXT NOT NULL
    );
  `);
  const db = drizzle(sqlite) as any;
  let lastBatchParamCounts: number[] = [];
  db.batch = async (statements: any[]) => {
    lastBatchParamCounts = statements.map((statement) => statement.toSQL().params.length);
    return sqlite.transaction(() => statements.map((statement) => {
      const query = statement.toSQL().sql.toLowerCase();
      return query.includes(" returning ") ? statement.all() : statement.run();
    }))();
  };
  return { sqlite, db, getLastBatchParamCounts: () => lastBatchParamCounts };
}

describe("community channel creator handoff", () => {
  it("hands a private channel tree to deterministic surviving scope members before leave", async () => {
    const { sqlite, db } = createDatabase();
    sqlite.exec(`
      INSERT INTO community_server (id) VALUES ('s1');
      INSERT INTO community_server_member (id, server_id, user_id, role, joined_at)
      VALUES
        ('sm-actor', 's1', 'actor', 'member', '2026-01-01T00:00:00.000Z'),
        ('sm-owner', 's1', 'owner', 'owner', '2026-01-01T00:00:01.000Z'),
        ('sm-channel-a', 's1', 'channel-a', 'member', '2026-01-01T00:00:02.000Z'),
        ('sm-channel-b', 's1', 'channel-b', 'member', '2026-01-01T00:00:03.000Z'),
        ('sm-thread-a', 's1', 'thread-a', 'member', '2026-01-01T00:00:04.000Z'),
        ('sm-thread-b', 's1', 'thread-b', 'member', '2026-01-01T00:00:05.000Z');
      INSERT INTO community_category (id, server_id, private) VALUES ('private', 's1', 1);
      INSERT INTO community_channel
        (id, server_id, category_id, type, parent_channel_id, creator_id)
      VALUES
        ('private-channel', 's1', 'private', 'text', NULL, 'actor'),
        ('child-thread', 's1', NULL, 'thread', 'private-channel', 'actor');
      INSERT INTO community_channel_member
        (id, channel_id, user_id, relation, added_at)
      VALUES
        ('access-actor', 'private-channel', 'actor', 'access', '2026-01-01T00:00:00.000Z'),
        ('access-stale', 'private-channel', 'not-in-server', 'access', '2025-01-01T00:00:00.000Z'),
        ('access-b', 'private-channel', 'channel-b', 'access', '2026-01-02T00:00:00.000Z'),
        ('access-a', 'private-channel', 'channel-a', 'access', '2026-01-02T00:00:00.000Z'),
        ('notify-actor', 'child-thread', 'actor', 'notify', '2026-01-01T00:00:00.000Z'),
        ('notify-stale', 'child-thread', 'not-in-server', 'notify', '2025-01-01T00:00:00.000Z'),
        ('notify-b', 'child-thread', 'thread-b', 'notify', '2026-01-02T00:00:00.000Z'),
        ('notify-a', 'child-thread', 'thread-a', 'notify', '2026-01-02T00:00:00.000Z');
    `);

    await expect(deleteChannelMemberAndChildParticipants(
      db,
      "private-channel",
      "actor",
    )).resolves.toBeTruthy();

    expect(sqlite.prepare(`
      SELECT id, creator_id AS creatorId FROM community_channel ORDER BY id
    `).all()).toEqual([
      { id: "child-thread", creatorId: "thread-a" },
      { id: "private-channel", creatorId: "channel-a" },
    ]);
    expect(sqlite.prepare(`
      SELECT id FROM community_channel_member WHERE user_id = 'actor'
    `).all()).toEqual([]);
  });

  it("falls back to the earliest surviving manager when a thread has no scope member", async () => {
    const { sqlite, db } = createDatabase();
    sqlite.exec(`
      INSERT INTO community_server (id) VALUES ('s1');
      INSERT INTO community_server_member (id, server_id, user_id, role, joined_at)
      VALUES
        ('sm-actor', 's1', 'actor', 'member', '2026-01-01T00:00:00.000Z'),
        ('manager-z', 's1', 'manager-z', 'owner', '2026-01-02T00:00:00.000Z'),
        ('manager-a', 's1', 'manager-a', 'admin', '2026-01-02T00:00:00.000Z');
      INSERT INTO community_channel
        (id, server_id, type, parent_channel_id, creator_id)
      VALUES
        ('parent', 's1', 'text', NULL, 'manager-z'),
        ('thread', 's1', 'thread', 'parent', 'actor');
    `);

    await expect(deleteThreadParticipantWithCreatorHandoff(
      db,
      "thread",
      "actor",
    )).resolves.toBeTruthy();

    expect(sqlite.prepare(`
      SELECT creator_id AS creatorId FROM community_channel WHERE id = 'thread'
    `).get()).toEqual({ creatorId: "manager-a" });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM community_channel WHERE id = 'thread'
    `).get()).toEqual({ count: 1 });
  });

  it("hands off every exact-server creator before cascade cleanup and preserves DMs and other servers", async () => {
    const { sqlite, db, getLastBatchParamCounts } = createDatabase();
    sqlite.exec(`
      INSERT INTO community_server (id) VALUES ('gone'), ('keep');
      INSERT INTO community_server_member (id, server_id, user_id, role, joined_at)
      VALUES
        ('target-gone', 'gone', 'target', 'member', '2026-01-01T00:00:00.000Z'),
        ('bot-gone', 'gone', 'bot', 'member', '2026-01-01T00:00:01.000Z'),
        ('public-first', 'gone', 'public-first', 'member', '2026-01-01T00:00:02.000Z'),
        ('scope-private', 'gone', 'scope-private', 'member', '2026-01-01T00:00:03.000Z'),
        ('scope-thread', 'gone', 'scope-thread', 'member', '2026-01-01T00:00:04.000Z'),
        ('manager', 'gone', 'manager', 'owner', '2026-01-01T00:00:05.000Z'),
        ('target-keep', 'keep', 'target', 'member', '2026-01-01T00:00:00.000Z');
      INSERT INTO community_category (id, server_id, private)
      VALUES ('private', 'gone', 1);
      INSERT INTO community_channel
        (id, server_id, category_id, type, parent_channel_id, creator_id)
      VALUES
        ('private-primary', 'gone', 'private', 'text', NULL, 'target'),
        ('public-primary', 'gone', NULL, 'text', NULL, 'bot'),
        ('thread-primary', 'gone', NULL, 'thread', 'public-primary', 'target'),
        ('private-fallback', 'gone', 'private', 'forum', NULL, 'bot'),
        ('thread-fallback', 'gone', NULL, 'thread', 'private-fallback', 'bot'),
        ('dm', NULL, NULL, 'dm', NULL, 'target'),
        ('keep-channel', 'keep', NULL, 'text', NULL, 'target');
      INSERT INTO community_channel_member
        (id, channel_id, user_id, relation, added_at)
      VALUES
        ('private-target', 'private-primary', 'target', 'access', '2026-01-01T00:00:00.000Z'),
        ('private-bot', 'private-primary', 'bot', 'access', '2026-01-01T00:00:01.000Z'),
        ('private-survivor', 'private-primary', 'scope-private', 'access', '2026-01-01T00:00:02.000Z'),
        ('thread-target', 'thread-primary', 'target', 'notify', '2026-01-01T00:00:00.000Z'),
        ('thread-bot', 'thread-primary', 'bot', 'notify', '2026-01-01T00:00:01.000Z'),
        ('thread-survivor', 'thread-primary', 'scope-thread', 'notify', '2026-01-01T00:00:02.000Z'),
        ('fallback-private-bot', 'private-fallback', 'bot', 'access', '2026-01-01T00:00:00.000Z'),
        ('fallback-thread-target', 'thread-fallback', 'target', 'notify', '2026-01-01T00:00:00.000Z'),
        ('keep-target', 'keep-channel', 'target', 'access', '2026-01-01T00:00:00.000Z');
    `);

    await expect(removeMemberAndOwnerBots(
      db,
      "target-gone",
      "gone",
      "target",
      ["bot"],
    )).resolves.toMatchObject({ id: "target-gone" });

    expect(sqlite.prepare(`
      SELECT id, creator_id AS creatorId FROM community_channel ORDER BY id
    `).all()).toEqual([
      { id: "dm", creatorId: "target" },
      { id: "keep-channel", creatorId: "target" },
      { id: "private-fallback", creatorId: "manager" },
      { id: "private-primary", creatorId: "scope-private" },
      { id: "public-primary", creatorId: "public-first" },
      { id: "thread-fallback", creatorId: "manager" },
      { id: "thread-primary", creatorId: "scope-thread" },
    ]);
    expect(sqlite.prepare(`
      SELECT channel_id AS channelId, user_id AS userId
      FROM community_channel_member
      ORDER BY channel_id, user_id
    `).all()).toEqual([
      { channelId: "keep-channel", userId: "target" },
      { channelId: "private-primary", userId: "scope-private" },
      { channelId: "thread-primary", userId: "scope-thread" },
    ]);
    expect(getLastBatchParamCounts().every((count) => count <= 100)).toBe(true);
  });
});
