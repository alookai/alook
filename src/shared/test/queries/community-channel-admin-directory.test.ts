import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db";
import { listServerChannelDirectoryForAdmin } from "../../src/db/queries/community/channel";

describe("listServerChannelDirectoryForAdmin", () => {
  let sqlite: Sqlite.Database;
  let db: Database;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, discriminator TEXT, email TEXT, deletedAt TEXT);
      CREATE TABLE community_server_member (id TEXT PRIMARY KEY, server_id TEXT, user_id TEXT, role TEXT);
      CREATE TABLE community_category (id TEXT PRIMARY KEY, server_id TEXT, name TEXT, position INTEGER, private INTEGER);
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY, server_id TEXT, category_id TEXT, name TEXT, type TEXT,
        position INTEGER, parent_channel_id TEXT, creator_id TEXT, created_at TEXT, topic TEXT
      );
      INSERT INTO user VALUES
        ('creator', 'Alice', '0042', 'private@example.com', NULL),
        ('deleted', 'Old name', '0043', 'deleted@example.com', '2026-01-01');
      INSERT INTO community_server_member VALUES
        ('a', 's1', 'admin', 'admin'), ('o', 's1', 'owner', 'owner'),
        ('m', 's1', 'creator', 'member'), ('a2', 's2', 'other-admin', 'admin');
      INSERT INTO community_category VALUES
        ('public', 's1', 'GENERAL', 2, 0), ('private', 's1', 'PRIVATE', 1, 1),
        ('s2-group', 's2', 'OTHER SERVER', 0, 0);
      INSERT INTO community_channel VALUES
        ('uncat', 's1', NULL, 'uncategorized', 'text', 0, NULL, NULL, '2026-10-01T00:00:00.000Z', 'secret'),
        ('public-text', 's1', 'public', 'general', 'text', 1, NULL, 'creator', '2026-10-01T01:00:00.000Z', 'secret'),
        ('private-forum', 's1', 'private', 'hidden-forum', 'forum', 0, NULL, 'creator', '2026-10-01T02:00:00.000Z', 'secret'),
        ('private-text', 's1', 'private', 'hidden-text', 'text', 1, NULL, 'creator', '2026-10-01T03:00:00.000Z', 'secret'),
        ('deleted-creator', 's1', 'public', 'old-channel', 'text', 2, NULL, 'deleted', '2026-10-01T04:00:00.000Z', 'secret'),
        ('missing-creator', 's1', 'public', 'missing-creator', 'text', 3, NULL, 'gone', '2026-10-01T05:00:00.000Z', 'secret'),
        ('thread', 's1', 'private', 'child-thread', 'thread', 0, 'private-forum', 'creator', '2026-10-01', 'secret'),
        ('child-text', 's1', 'private', 'invalid-child', 'text', 0, 'private-text', 'creator', '2026-10-01', 'secret'),
        ('top-thread', 's1', NULL, 'invalid-top-thread', 'thread', 0, NULL, 'creator', '2026-10-01', 'secret'),
        ('dm', 's1', NULL, 'dm', 'dm', 0, NULL, 'creator', '2026-10-01', 'secret'),
        ('other-server', 's2', 's2-group', 'other', 'text', 0, NULL, 'creator', '2026-10-01', 'secret');
    `);
    db = drizzle(sqlite) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  it.each(["admin", "owner"])("includes unjoined private top-level channels for %s, in group order", async (viewer) => {
    const rows = await listServerChannelDirectoryForAdmin(db, "s1", viewer);
    expect(rows.map((row) => row.id)).toEqual([
      "uncat", "private-forum", "private-text", "public-text", "deleted-creator", "missing-creator",
    ]);
    expect(rows[0]).toEqual({
      id: "uncat", name: "uncategorized", type: "text", category: null, creator: null, createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(rows[1]).toEqual({
      id: "private-forum", name: "hidden-forum", type: "forum", category: { id: "private", name: "PRIVATE", private: true },
      creator: { name: "Alice", handle: "Alice#0042" }, createdAt: "2026-10-01T02:00:00.000Z",
    });
    expect(rows[3]!.category?.private).toBe(false);
    expect(rows[4]!.creator).toBeNull();
    expect(rows[5]!.creator).toBeNull();
    expect(JSON.stringify(rows)).not.toMatch(/secret|email|discriminator|creatorId|topic/);
  });

  it.each(["creator", "outsider", "other-admin"])("does not read metadata for unauthorized viewer %s", async (viewer) => {
    await expect(listServerChannelDirectoryForAdmin(db, "s1", viewer)).resolves.toEqual([]);
  });

  it("scopes admin membership to the requested server", async () => {
    await expect(listServerChannelDirectoryForAdmin(db, "s2", "admin")).resolves.toEqual([]);
    expect((await listServerChannelDirectoryForAdmin(db, "s2", "other-admin")).map((row) => row.id)).toEqual(["other-server"]);
    await expect(listServerChannelDirectoryForAdmin(db, "nonexistent", "admin")).resolves.toEqual([]);
  });

  it("stops returning metadata immediately after an admin is downgraded", async () => {
    sqlite.prepare("UPDATE community_server_member SET role = 'member' WHERE user_id = ?").run("admin");
    await expect(listServerChannelDirectoryForAdmin(db, "s1", "admin")).resolves.toEqual([]);
  });
});
