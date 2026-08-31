import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { projectServerRailCommit } from "../../src/community-server-rail";
import { removeMemberAndOwnerBots } from "../../src/db/queries/community/member";
import {
  buildServerRailWriteStatements,
  readServerRailSnapshot,
} from "../../src/db/queries/community/server-rail";

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
    CREATE TABLE community_channel (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
      category_id TEXT,
      type TEXT NOT NULL DEFAULT 'text',
      parent_channel_id TEXT,
      creator_id TEXT
    );
    CREATE TABLE community_category (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES community_server(id) ON DELETE CASCADE,
      private INTEGER DEFAULT 0
    );
    CREATE TABLE community_channel_member (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'added',
      added_by TEXT,
      added_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
  `);
  const db = drizzle(sqlite) as any;
  let lastBatchParamCounts: number[] = [];
  db.batch = async (statements: any[]) => {
    lastBatchParamCounts = statements.map((statement) => statement.toSQL().params.length);
    return sqlite.transaction(() =>
      statements.map((statement, index) => index === 4 ? statement.all() : statement.run()),
    )();
  };
  return { sqlite, db, getLastBatchParamCounts: () => lastBatchParamCounts };
}

describe("member removal server rail cleanup", () => {
  it("removes unique-item folders for the target and owner bots before the next rail mutation", async () => {
    const { sqlite, db } = createDatabase();
    sqlite.exec(`
      INSERT INTO community_server (id) VALUES ('gone'), ('keep');
      INSERT INTO community_server_member (id, server_id, user_id, role, rail_order, joined_at)
      VALUES
        ('target-gone', 'gone', 'target', 'member', 0, '2026-01-01T00:00:00.000Z'),
        ('target-keep', 'keep', 'target', 'member', 1, '2026-01-01T00:00:01.000Z'),
        ('bot-gone', 'gone', 'bot', 'member', 0, '2026-01-01T00:00:00.000Z'),
        ('other-gone', 'gone', 'other', 'member', 0, '2026-01-01T00:00:00.000Z');
      INSERT INTO community_server_folder (id, user_id, name, position)
      VALUES
        ('target-folder', 'target', 'Target', 0),
        ('bot-folder', 'bot', 'Bot', 0),
        ('other-folder', 'other', 'Other', 0);
      INSERT INTO community_server_folder_item (folder_id, server_id, position)
      VALUES
        ('target-folder', 'gone', 0),
        ('bot-folder', 'gone', 0),
        ('other-folder', 'gone', 0);
      INSERT INTO community_channel (id, server_id)
      VALUES ('gone-channel', 'gone'), ('keep-channel', 'keep');
      INSERT INTO community_channel_member (id, channel_id, user_id, relation)
      VALUES
        ('target-gone-access', 'gone-channel', 'target', 'access'),
        ('bot-gone-notify', 'gone-channel', 'bot', 'notify'),
        ('other-gone-access', 'gone-channel', 'other', 'access'),
        ('target-keep-access', 'keep-channel', 'target', 'access'),
        ('bot-keep-notify', 'keep-channel', 'bot', 'notify');
    `);

    await expect(removeMemberAndOwnerBots(
      db,
      "target-gone",
      "gone",
      "target",
      ["bot"],
    )).resolves.toMatchObject({ id: "target-gone" });

    expect(sqlite.prepare(`
      SELECT id FROM community_server_folder ORDER BY id
    `).all()).toEqual([{ id: "other-folder" }]);
    expect(sqlite.prepare(`
      SELECT folder_id AS folderId, server_id AS serverId
      FROM community_server_folder_item
    `).all()).toEqual([{ folderId: "other-folder", serverId: "gone" }]);
    expect(sqlite.prepare(`
      SELECT id, channel_id AS channelId, user_id AS userId, relation
      FROM community_channel_member
      ORDER BY id
    `).all()).toEqual([
      { id: "bot-keep-notify", channelId: "keep-channel", userId: "bot", relation: "notify" },
      { id: "other-gone-access", channelId: "gone-channel", userId: "other", relation: "access" },
      { id: "target-keep-access", channelId: "keep-channel", userId: "target", relation: "access" },
    ]);

    db.batch = async (statements: any[]) => statements.map((statement) => statement.all());
    const snapshot = await readServerRailSnapshot(db, "target");
    expect(snapshot).toEqual({ serverOrder: ["keep"], folderOrder: [], folders: {} });
    const next = projectServerRailCommit(snapshot, {
      commands: [{
        kind: "create-folder",
        clientId: "next",
        name: "Next",
        serverIds: ["keep"],
      }],
    }, () => "next-folder");
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error(next.error);
    const statements = buildServerRailWriteStatements(db, "target", next.value);
    expect(() => sqlite.transaction(() => statements.forEach((statement) => statement.run()))())
      .not.toThrow();
  });

  it("cleans more than 100 removed users with bounded binds and preserves other scopes", async () => {
    const { sqlite, db, getLastBatchParamCounts } = createDatabase();
    sqlite.exec(`
      INSERT INTO community_server (id) VALUES ('gone'), ('keep');
      INSERT INTO community_server_member (id, server_id, user_id, role, rail_order, joined_at)
      VALUES ('target-gone', 'gone', 'target', 'member', 0, '2026-01-01T00:00:00.000Z');
      INSERT INTO community_channel (id, server_id)
      VALUES ('gone-channel', 'gone'), ('keep-channel', 'keep');
      INSERT INTO community_channel_member (id, channel_id, user_id, relation)
      VALUES ('other-gone', 'gone-channel', 'other', 'access');
    `);

    const botIds = Array.from({ length: 120 }, (_, index) => `bot-${index}`);
    const insertMember = sqlite.prepare(`
      INSERT INTO community_server_member (id, server_id, user_id, role, rail_order, joined_at)
      VALUES (?, 'gone', ?, 'member', 0, '2026-01-01T00:00:00.000Z')
    `);
    const insertChannelMember = sqlite.prepare(`
      INSERT INTO community_channel_member (id, channel_id, user_id, relation)
      VALUES (?, ?, ?, 'access')
    `);
    sqlite.transaction(() => {
      for (const botId of botIds) {
        insertMember.run(`member-${botId}`, botId);
        insertChannelMember.run(`gone-${botId}`, "gone-channel", botId);
        insertChannelMember.run(`keep-${botId}`, "keep-channel", botId);
      }
    })();

    await expect(removeMemberAndOwnerBots(
      db,
      "target-gone",
      "gone",
      "target",
      botIds,
    )).resolves.toMatchObject({ id: "target-gone" });

    expect(getLastBatchParamCounts().every((count) => count <= 100)).toBe(true);
    expect(getLastBatchParamCounts()[3]).toBeLessThanOrEqual(2);
    expect(sqlite.prepare(`
      SELECT id FROM community_channel_member
      WHERE channel_id = 'gone-channel'
      ORDER BY id
    `).all()).toEqual([{ id: "other-gone" }]);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM community_channel_member
      WHERE channel_id = 'keep-channel'
    `).get()).toEqual({ count: 120 });
  });
});
