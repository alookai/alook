import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { Database } from "../../src/db";
import {
  listChildChannelsByParentMessageIds,
} from "../../src/db/queries/community/channel";

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

});
