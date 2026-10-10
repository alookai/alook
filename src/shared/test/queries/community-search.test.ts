import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import type { Database } from "../../src/db";
import { sanitizeFtsQuery, searchMessagesInServer } from "../../src/db/queries/community/search";

describe("sanitizeFtsQuery", () => {
  it("single word produces prefix match", () => {
    expect(sanitizeFtsQuery("hi")).toBe('"hi"*');
  });

  it("multiple words produce implicit AND with prefix on each", () => {
    expect(sanitizeFtsQuery("hello world")).toBe('"hello"* "world"*');
  });

  it("strips FTS special characters", () => {
    expect(sanitizeFtsQuery('"test-case"')).toBe('"test"* "case"*');
  });

  it("strips FTS keywords", () => {
    expect(sanitizeFtsQuery("not bad")).toBe('"bad"*');
    expect(sanitizeFtsQuery("cats AND dogs")).toBe('"cats"* "dogs"*');
  });

  it("returns empty phrase for empty input", () => {
    expect(sanitizeFtsQuery("")).toBe('""');
    expect(sanitizeFtsQuery("   ")).toBe('""');
  });

  it("handles all-keyword input as empty", () => {
    expect(sanitizeFtsQuery("AND OR NOT")).toBe('""');
  });
});

describe("searchMessagesInServer against real SQLite", () => {
  let sqlite: Sqlite.Database;
  let db: Database;
  const quotedChannel = "visible'quoted";

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL,
        emailVerified INTEGER, image TEXT, avatarVersion INTEGER NOT NULL DEFAULT 0,
        avatarObjectKey TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        isBot INTEGER NOT NULL DEFAULT 0, ownerUserId TEXT, deletedAt TEXT,
        discriminator TEXT NOT NULL DEFAULT '0000', lastRefreshContextAt TEXT
      );
      CREATE TABLE community_channel (id TEXT PRIMARY KEY, server_id TEXT);
      CREATE TABLE community_message (
        id TEXT PRIMARY KEY, author_id TEXT NOT NULL, content TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'default', mention_type TEXT, reply_to_id TEXT,
        embeds TEXT, created_at TEXT NOT NULL, channel_id TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0, friendship_id TEXT, client_nonce TEXT
      );
      INSERT INTO user (id, email, createdAt, updatedAt)
        VALUES ('author', 'author@example.com', '2026-09-01', '2026-09-01');
    `);
    const insertChannel = sqlite.prepare("INSERT INTO community_channel (id, server_id) VALUES (?, ?)");
    for (const channelId of ["visible", quotedChannel, "unauthorized"]) insertChannel.run(channelId, "server");
    insertChannel.run("outside", "other-server");
    const insertMessage = sqlite.prepare(`
      INSERT INTO community_message (id, author_id, content, channel_id, created_at)
      VALUES (?, 'author', ?, ?, ?)
    `);
    insertMessage.run("old-visible", "needle", "visible", "2026-09-01T00:01:00.000Z");
    insertMessage.run("new-visible", "needle", "visible", "2026-09-01T00:05:00.000Z");
    insertMessage.run("literal-visible", "needle", quotedChannel, "2026-09-01T00:03:00.000Z");
    insertMessage.run("hidden", "needle", "unauthorized", "2026-09-01T00:06:00.000Z");
    insertMessage.run("other-server", "needle", "outside", "2026-09-01T00:07:00.000Z");
    insertMessage.run("wrong-content", "haystack", "visible", "2026-09-01T00:08:00.000Z");
    db = drizzle(sqlite) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  it("intersects server and visible channels before the global newest limit", async () => {
    const rows = await searchMessagesInServer(db, {
      query: "needle", serverId: "server", visibleChannelIds: ["visible", quotedChannel, "outside"], limit: 2,
    });
    expect(rows.map((row) => row.message.id)).toEqual(["new-visible", "literal-visible"]);
  });

  it("keeps undefined visibility trusted within the requested server", async () => {
    const rows = await searchMessagesInServer(db, { query: "needle", serverId: "server", limit: 3 });
    expect(rows.map((row) => row.message.id)).toEqual(["hidden", "new-visible", "literal-visible"]);
  });

  it("returns no rows for an explicitly empty visible set", async () => {
    const rows = await searchMessagesInServer(db, { query: "needle", serverId: "server", visibleChannelIds: [] });
    expect(rows).toEqual([]);
  });

  it("keeps large repeated visible sets literal, scoped and unique", async () => {
    const visibleChannelIds = ["visible", quotedChannel, "outside", ...Array.from({ length: 150 }, (_, i) => `missing-${i}`), "visible", quotedChannel];
    const rows = await searchMessagesInServer(db, { query: "needle", serverId: "server", visibleChannelIds, limit: 2 });
    expect(rows.map((row) => row.message.id)).toEqual(["new-visible", "literal-visible"]);
  });
});
