import Sqlite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../web/migrations/0104_community_mention_explicit.sql", import.meta.url),
  "utf8",
);

describe("0104 community mention explicit migration", () => {
  let sqlite: Sqlite.Database | undefined;

  afterEach(() => sqlite?.close());

  it("backfills only mentions whose committed message was not a broadcast", () => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE community_message (
        id TEXT PRIMARY KEY,
        mention_type TEXT
      );
      CREATE TABLE community_mention (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'mention',
        read INTEGER DEFAULT 0
      );
      INSERT INTO community_message (id, mention_type) VALUES
        ('direct', NULL),
        ('broadcast', 'everyone'),
        ('reply', NULL);
      INSERT INTO community_mention (id, message_id, user_id, kind) VALUES
        ('m1', 'direct', 'u1', 'mention'),
        ('m2', 'broadcast', 'u2', 'mention'),
        ('m3', 'reply', 'u3', 'reply');
    `);

    sqlite.exec(migration);

    expect(sqlite.prepare(`
      SELECT id, is_explicit
      FROM community_mention
      ORDER BY id
    `).all()).toEqual([
      { id: "m1", is_explicit: 1 },
      { id: "m2", is_explicit: 0 },
      { id: "m3", is_explicit: 0 },
    ]);
  });
});
