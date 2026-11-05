import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import type { Database } from "../../src/db";
import { resolveChannelByNameForMember } from "../../src/db/queries/community/channel";

describe("resolveChannelByNameForMember — native SQLite scope", () => {
  let sqlite: Sqlite.Database;
  let db: Database;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY);
      CREATE TABLE community_server (id TEXT PRIMARY KEY);
      CREATE TABLE community_server_member (
        id TEXT PRIMARY KEY, server_id TEXT NOT NULL, user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member', joined_at TEXT NOT NULL,
        UNIQUE(server_id, user_id)
      );
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY, server_id TEXT NOT NULL, category_id TEXT,
        name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text',
        topic TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
        parent_channel_id TEXT, creator_id TEXT NOT NULL DEFAULT 'u_1',
        message_count INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        parent_message_id TEXT, last_message_at TEXT,
        created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
      );
      CREATE TABLE community_message (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL);
      INSERT INTO user VALUES ('u_1'), ('u_2'), ('u_peer'), ('u_none');
      INSERT INTO community_server VALUES ('srv_1'), ('srv_2');
      INSERT INTO community_server_member (id, server_id, user_id, joined_at) VALUES
        ('m_1a', 'srv_1', 'u_1', '2025-01-01T00:00:00.000Z'),
        ('m_1b', 'srv_2', 'u_1', '2025-01-01T00:00:00.000Z'),
        ('m_2', 'srv_2', 'u_2', '2025-01-01T00:00:00.000Z'),
        ('m_peer', 'srv_1', 'u_peer', '2025-01-01T00:00:00.000Z');
      INSERT INTO community_channel (id, server_id, name) VALUES
        ('ch_top', 'srv_1', 'general'),
        ('ch_foreign', 'srv_2', 'general'),
        ('ch_random', 'srv_1', 'random'),
        ('mFUplbfFL7PIzeiaP3Ysg', 'srv_1', 'opaque-name');
      INSERT INTO community_message VALUES ('opener', 'ch_top');
      INSERT INTO community_channel (id, server_id, name, type, parent_channel_id, parent_message_id)
        VALUES ('ch_child', 'srv_1', 'general', 'thread', 'ch_top', 'opener');
    `);
    db = drizzle(sqlite) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  it("filters by name AND parent_channel_id IS NULL (top-level only)", async () => {
    const rows = await resolveChannelByNameForMember(db, "srv_1", "u_1", "general");
    expect(rows.map(({ id, name, parentChannelId }) => ({ id, name, parentChannelId })))
      .toEqual([{ id: "ch_top", name: "general", parentChannelId: null }]);
  });

  it("does NOT fall back to matching by id (agent surfaces reject raw ids)", async () => {
    expect(await resolveChannelByNameForMember(db, "srv_1", "u_1", "mFUplbfFL7PIzeiaP3Ysg"))
      .toEqual([]);
    expect((await resolveChannelByNameForMember(db, "srv_1", "u_1", "opaque-name")).map((row) => row.id))
      .toEqual(["mFUplbfFL7PIzeiaP3Ysg"]);
  });

  it("scopes lookup to server AND caller's membership (no cross-server leak)", async () => {
    expect((await resolveChannelByNameForMember(db, "srv_1", "u_1", "general")).map((row) => row.id))
      .toEqual(["ch_top"]);
    expect((await resolveChannelByNameForMember(db, "srv_2", "u_1", "general")).map((row) => row.id))
      .toEqual(["ch_foreign"]);
    expect(await resolveChannelByNameForMember(db, "srv_1", "u_2", "general")).toEqual([]);
    expect((await resolveChannelByNameForMember(db, "srv_2", "u_2", "general")).map((row) => row.id))
      .toEqual(["ch_foreign"]);
    expect(await resolveChannelByNameForMember(db, "srv_1", "u_none", "general")).toEqual([]);
  });

  it("returns [] when no top-level row matches", async () => {
    expect(await resolveChannelByNameForMember(db, "srv_1", "u_1", "missing")).toEqual([]);
  });

  it("returns the single matched row", async () => {
    expect(await resolveChannelByNameForMember(db, "srv_1", "u_1", "general")).toEqual([{
      id: "ch_top",
      serverId: "srv_1",
      categoryId: null,
      name: "general",
      type: "text",
      topic: "",
      position: 0,
      parentChannelId: null,
      creatorId: "u_1",
      messageCount: 0,
      archived: 0,
      parentMessageId: null,
      lastMessageAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);
  });
});
