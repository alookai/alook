import Sqlite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import { communityChannel } from "../../src/db/community-schema";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  testDirectory,
  "../../../web/migrations/0089_community_channel_parent_message_fk.sql",
);

type ChannelRow = {
  id: string;
  server_id: string | null;
  type: string;
  parent_channel_id: string | null;
  parent_message_id: string | null;
  message_count: number;
  last_message_at: string | null;
};

function createCurrentSchema(sqlite: Sqlite.Database): void {
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE community_server (id TEXT PRIMARY KEY);
    CREATE TABLE community_channel (
      id TEXT PRIMARY KEY,
      server_id TEXT REFERENCES community_server(id) ON DELETE CASCADE,
      category_id TEXT,
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
      created_at TEXT NOT NULL
    );
    CREATE TABLE community_message (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'default',
      mention_type TEXT,
      reply_to_id TEXT,
      embeds TEXT,
      created_at TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL DEFAULT 0,
      friendship_id TEXT,
      client_nonce TEXT
    );
    CREATE UNIQUE INDEX idx_channel_parent_message
      ON community_channel(parent_message_id) WHERE parent_message_id IS NOT NULL;
    CREATE UNIQUE INDEX uq_community_channel_parent_message
      ON community_channel(parent_channel_id, parent_message_id)
      WHERE parent_channel_id IS NOT NULL AND parent_message_id IS NOT NULL;
    CREATE INDEX idx_channel_forum_created
      ON community_channel(parent_channel_id, created_at DESC, id DESC)
      WHERE type = 'thread' AND archived = 0 AND parent_message_id IS NOT NULL;
  `);
}

function insertChannel(
  sqlite: Sqlite.Database,
  row: {
    id: string;
    type: string;
    parentChannelId?: string | null;
    parentMessageId?: string | null;
    serverId?: string | null;
    messageCount?: number;
    lastMessageAt?: string | null;
  },
): void {
  sqlite.prepare(`
    INSERT INTO community_channel (
      id, server_id, name, type, parent_channel_id, message_count,
      archived, parent_message_id, last_message_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    row.id,
    row.serverId === undefined ? "server_1" : row.serverId,
    row.id,
    row.type,
    row.parentChannelId ?? null,
    row.messageCount ?? 0,
    row.parentMessageId ?? null,
    row.lastMessageAt ?? null,
    `2026-08-23T00:00:0${row.id.length % 10}.000Z`,
  );
}

function insertMessage(
  sqlite: Sqlite.Database,
  id: string,
  channelId: string,
  seq: number,
): void {
  sqlite.prepare(`
    INSERT INTO community_message (
      id, author_id, content, created_at, channel_id, seq
    ) VALUES (?, 'user_1', ?, ?, ?, ?)
  `).run(id, id, `2026-08-23T00:01:${String(seq).padStart(2, "0")}.000Z`, channelId, seq);
}

function applyMigration(sqlite: Sqlite.Database): void {
  const migration = readFileSync(migrationPath, "utf8");
  sqlite.transaction(() => sqlite.exec(migration))();
}

function listChannels(sqlite: Sqlite.Database): ChannelRow[] {
  return sqlite.prepare(`
    SELECT id, server_id, type, parent_channel_id, parent_message_id,
           message_count, last_message_at
    FROM community_channel ORDER BY id
  `).all() as ChannelRow[];
}

function listAllChannels(sqlite: Sqlite.Database): unknown[] {
  return sqlite.prepare("SELECT * FROM community_channel ORDER BY id").all();
}

function targetIndexDefinitions(sqlite: Sqlite.Database): Array<{ name: string; sql: string }> {
  return (sqlite.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'idx_channel_parent_message',
      'uq_community_channel_parent_message',
      'idx_channel_forum_created'
    )
    ORDER BY name
  `).all() as Array<{ name: string; sql: string }>).map((row) => ({
    name: row.name,
    sql: row.sql.replace(/\s+/g, " ").trim().toLowerCase(),
  }));
}

describe("0089 community_channel.parent_message_id cascade FK", () => {
  let sqlite: Sqlite.Database | undefined;

  afterEach(() => sqlite?.close());

  it("mirrors the parent-message cascade in the Drizzle schema", () => {
    const parentMessageFk = getTableConfig(communityChannel).foreignKeys.find((foreignKey) =>
      foreignKey.reference().columns.some((column) => column.name === "parent_message_id")
    );

    expect(parentMessageFk?.reference()).toMatchObject({
      foreignColumns: [{ name: "id" }],
    });
    expect(parentMessageFk?.onDelete).toBe("cascade");
  });

  it("preserves valid forum and ordinary text threads, then cascades only the selected opener unit", () => {
    sqlite = new Sqlite(":memory:");
    createCurrentSchema(sqlite);
    sqlite.prepare("INSERT INTO community_server (id) VALUES (?)").run("server_1");

    insertChannel(sqlite, { id: "forum", type: "forum", messageCount: 2 });
    insertChannel(sqlite, { id: "text", type: "text", messageCount: 1 });
    insertMessage(sqlite, "forum_opener", "forum", 1);
    insertMessage(sqlite, "forum_sibling_opener", "forum", 2);
    insertMessage(sqlite, "text_opener", "text", 1);
    insertChannel(sqlite, {
      id: "forum_child",
      type: "thread",
      parentChannelId: "forum",
      parentMessageId: "forum_opener",
      messageCount: 1,
    });
    insertChannel(sqlite, {
      id: "forum_sibling",
      type: "thread",
      parentChannelId: "forum",
      parentMessageId: "forum_sibling_opener",
    });
    insertChannel(sqlite, {
      id: "text_thread",
      type: "thread",
      parentChannelId: "text",
      parentMessageId: "text_opener",
      messageCount: 1,
    });
    insertMessage(sqlite, "forum_reply", "forum_child", 1);
    insertMessage(sqlite, "text_reply", "text_thread", 1);

    const before = listChannels(sqlite);
    const allColumnsBefore = listAllChannels(sqlite);
    const indexesBefore = targetIndexDefinitions(sqlite);
    applyMigration(sqlite);

    expect(listChannels(sqlite)).toEqual(before);
    expect(listAllChannels(sqlite)).toEqual(allColumnsBefore);
    expect(targetIndexDefinitions(sqlite)).toEqual(indexesBefore);
    const parentMessageFk = (sqlite.pragma("foreign_key_list('community_channel')") as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>).find((fk) => fk.from === "parent_message_id");
    expect(parentMessageFk).toMatchObject({
      table: "community_message",
      to: "id",
      on_delete: "CASCADE",
    });
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);

    sqlite.prepare("DELETE FROM community_message WHERE id = ?").run("forum_opener");

    expect(listChannels(sqlite).map((row) => row.id)).toEqual([
      "forum",
      "forum_sibling",
      "text",
      "text_thread",
    ]);
    expect(sqlite.prepare("SELECT id FROM community_message ORDER BY id").all()).toEqual([
      { id: "forum_sibling_opener" },
      { id: "text_opener" },
      { id: "text_reply" },
    ]);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });

  it.each([
    {
      label: "orphan opener",
      arrange(db: Sqlite.Database) {
        insertChannel(db, { id: "forum", type: "forum" });
        insertChannel(db, {
          id: "child",
          type: "thread",
          parentChannelId: "forum",
          parentMessageId: "missing",
        });
      },
    },
    {
      label: "opener in the wrong parent scope",
      arrange(db: Sqlite.Database) {
        insertChannel(db, { id: "forum", type: "forum" });
        insertChannel(db, { id: "other", type: "forum" });
        insertMessage(db, "opener", "other", 1);
        insertChannel(db, {
          id: "child",
          type: "thread",
          parentChannelId: "forum",
          parentMessageId: "opener",
        });
      },
    },
    {
      label: "child thread without an opener",
      arrange(db: Sqlite.Database) {
        insertChannel(db, { id: "forum", type: "forum" });
        insertChannel(db, {
          id: "child",
          type: "thread",
          parentChannelId: "forum",
          parentMessageId: null,
        });
      },
    },
    {
      label: "missing parent channel",
      arrange(db: Sqlite.Database) {
        insertChannel(db, { id: "forum", type: "forum" });
        insertMessage(db, "opener", "forum", 1);
        db.pragma("foreign_keys = OFF");
        insertChannel(db, {
          id: "child",
          type: "thread",
          parentChannelId: "missing",
          parentMessageId: "opener",
        });
        db.pragma("foreign_keys = ON");
      },
    },
    {
      label: "non-thread child relation",
      arrange(db: Sqlite.Database) {
        insertChannel(db, { id: "forum", type: "forum" });
        insertMessage(db, "opener", "forum", 1);
        insertChannel(db, {
          id: "child",
          type: "text",
          parentChannelId: "forum",
          parentMessageId: "opener",
        });
      },
    },
    {
      label: "server mismatch",
      arrange(db: Sqlite.Database) {
        db.prepare("INSERT INTO community_server (id) VALUES (?)").run("server_2");
        insertChannel(db, { id: "forum", type: "forum", serverId: "server_1" });
        insertMessage(db, "opener", "forum", 1);
        insertChannel(db, {
          id: "child",
          type: "thread",
          serverId: "server_2",
          parentChannelId: "forum",
          parentMessageId: "opener",
        });
      },
    },
  ])("aborts before schema mutation for $label", ({ arrange }) => {
    sqlite = new Sqlite(":memory:");
    createCurrentSchema(sqlite);
    sqlite.prepare("INSERT INTO community_server (id) VALUES (?)").run("server_1");
    arrange(sqlite);
    const before = listChannels(sqlite);

    expect(() => applyMigration(sqlite!)).toThrow(/community_channel parent_message_id audit failed/i);

    expect(listChannels(sqlite)).toEqual(before);
    expect(sqlite.prepare("PRAGMA table_info('community_channel')").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "parent_message_id" })]),
    );
    const fks = sqlite.pragma("foreign_key_list('community_channel')") as Array<{ from: string }>;
    expect(fks.some((fk) => fk.from === "parent_message_id")).toBe(false);
  });
});
