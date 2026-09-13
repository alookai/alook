import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "../../src/db";

export function communityWriteDb() {
  const sqlite = new Sqlite(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE user (id TEXT PRIMARY KEY);
    INSERT INTO user VALUES ('author'), ('peer');
    CREATE TABLE community_channel (
      id TEXT PRIMARY KEY, server_id TEXT, category_id TEXT, name TEXT,
      type TEXT NOT NULL DEFAULT 'text', topic TEXT DEFAULT '', position INTEGER DEFAULT 0,
      parent_channel_id TEXT REFERENCES community_channel(id), creator_id TEXT,
      message_count INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
      parent_message_id TEXT REFERENCES community_message(id), last_message_at TEXT, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX thread_anchor ON community_channel(parent_channel_id, parent_message_id) WHERE parent_message_id IS NOT NULL;
    CREATE TABLE community_channel_member (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES community_channel(id),
      user_id TEXT NOT NULL REFERENCES user(id), relation TEXT NOT NULL DEFAULT 'access',
      source TEXT NOT NULL DEFAULT 'added', added_by TEXT, added_at TEXT NOT NULL,
      UNIQUE(channel_id, user_id, relation)
    );
    CREATE TABLE community_message (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES user(id), content TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'default', mention_type TEXT, reply_to_id TEXT, embeds TEXT,
      created_at TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES community_channel(id),
      seq INTEGER NOT NULL, friendship_id TEXT, client_nonce TEXT
    );
    CREATE UNIQUE INDEX uq_community_message_channel_seq ON community_message(channel_id, seq) WHERE seq > 0;
    CREATE UNIQUE INDEX uq_message_author_client_nonce ON community_message(author_id, client_nonce) WHERE client_nonce IS NOT NULL;
    CREATE TABLE community_message_seq (channel_id TEXT PRIMARY KEY REFERENCES community_channel(id), next_seq INTEGER NOT NULL);
    CREATE TABLE community_read_state (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, last_read_at TEXT, last_read_message_id TEXT, last_read_seq INTEGER NOT NULL,
      UNIQUE(user_id, channel_id)
    );
    CREATE TABLE community_read_state_revision (user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE community_attachment (
      id TEXT PRIMARY KEY, uploader_id TEXT NOT NULL, target_id TEXT NOT NULL REFERENCES community_channel(id),
      message_id TEXT REFERENCES community_message(id), position INTEGER DEFAULT 0
    );
    CREATE TABLE community_mention (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES community_message(id), user_id TEXT NOT NULL REFERENCES user(id),
      kind TEXT NOT NULL DEFAULT 'mention', read INTEGER DEFAULT 0
    );
    CREATE TABLE activity (sent INTEGER NOT NULL);
    INSERT INTO activity VALUES (0);
    INSERT INTO community_channel (id, type, created_at) VALUES ('channel', 'text', 'now');
  `);
  const orm = drizzle(sqlite);
  const batchSizes: number[][] = [];
  const db = orm as unknown as Database;
  (db as any).batch = async (statements: any[]) => {
    batchSizes.push(statements.map((statement) => statement.toSQL().params.length));
    return sqlite.transaction(() => statements.map((statement) => {
      const query = statement.toSQL();
      return sqlite.prepare(query.sql).reader ? statement.all() : statement.run();
    }))();
  };
  return { sqlite, db, batchSizes };
}
