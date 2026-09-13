import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as coreSchema from "../../src/db/schema";
import * as communitySchema from "../../src/db/community-schema";
import type { Database } from "../../src/db";
import { getPushNotificationTarget } from "../../src/db/queries/community/notification-target";

const schema = { ...coreSchema, ...communitySchema };

describe("community notification target query", () => {
  let sqlite: Sqlite.Database;
  let db: Database;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
      CREATE TABLE community_message (
        id TEXT PRIMARY KEY NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        channel_id TEXT NOT NULL
      );
      CREATE TABLE community_attachment (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT,
        content_type TEXT,
        position INTEGER,
        created_at TEXT NOT NULL
      );
      INSERT INTO user (id, name) VALUES ('author-1', 'Alice');
      INSERT INTO community_message (id, author_id, content, channel_id)
        VALUES ('message-1', 'author-1', '**hello**', 'channel-1');
      INSERT INTO community_attachment
        (id, message_id, content_type, position, created_at)
        VALUES
        ('attachment-2', 'message-1', 'application/pdf', 1, '2026-09-12T00:00:01.000Z'),
        ('attachment-1', 'message-1', 'image/png', 0, '2026-09-12T00:00:00.000Z');
    `);
    db = drizzle(sqlite, { schema }) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  it("loads minimal display content only after the caller has gated eligibility", async () => {
    await expect(getPushNotificationTarget(db, "message-1")).resolves.toEqual({
      messageId: "message-1",
      channelId: "channel-1",
      authorName: "Alice",
      content: "**hello**",
      attachmentContentTypes: ["image/png", "application/pdf"],
    });
  });

  it("returns null for a deleted or missing message", async () => {
    await expect(getPushNotificationTarget(db, "missing")).resolves.toBeNull();
  });
});
