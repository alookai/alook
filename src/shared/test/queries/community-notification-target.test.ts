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
      CREATE TABLE community_server (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY NOT NULL,
        server_id TEXT,
        name TEXT,
        type TEXT NOT NULL,
        parent_channel_id TEXT
      );
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
      INSERT INTO user (id, name) VALUES
        ('author-1', 'Alice'),
        ('author-blank', '   ');
      INSERT INTO community_server (id, name) VALUES
        ('server-1', 'Studio'),
        ('server-blank', '   ');
      INSERT INTO community_channel
        (id, server_id, name, type, parent_channel_id)
        VALUES
        ('dm-1', NULL, NULL, 'dm', NULL),
        ('channel-1', 'server-1', 'general', 'text', NULL),
        ('forum-1', 'server-1', 'announcements', 'forum', NULL),
        ('post-1', 'server-1', 'Release notes', 'thread', 'forum-1'),
        ('thread-1', 'server-1', 'Focused work', 'thread', 'channel-1'),
        ('channel-blank', 'server-blank', '   ', 'text', NULL),
        ('thread-blank', 'server-blank', NULL, 'thread', 'channel-blank'),
        ('thread-orphan', 'server-missing', 'Still pushable', 'thread', 'parent-missing');
      INSERT INTO community_message (id, author_id, content, channel_id) VALUES
        ('message-dm', 'author-1', '**hello**', 'dm-1'),
        ('message-channel', 'author-1', '**hello**', 'channel-1'),
        ('message-thread', 'author-1', '**hello**', 'thread-1'),
        ('message-post', 'author-1', '**hello**', 'post-1'),
        ('message-fallback', 'author-blank', '**hello**', 'thread-blank'),
        ('message-orphan', 'author-1', '**hello**', 'thread-orphan');
      INSERT INTO community_attachment
        (id, message_id, content_type, position, created_at)
        VALUES
        ('attachment-2', 'message-channel', 'application/pdf', 1, '2026-09-12T00:00:01.000Z'),
        ('attachment-1', 'message-channel', 'image/png', 0, '2026-09-12T00:00:00.000Z');
    `);
    db = drizzle(sqlite, { schema }) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  it("loads a DM target without server presentation fields", async () => {
    await expect(getPushNotificationTarget(db, "message-dm")).resolves.toEqual({
      messageId: "message-dm",
      channelId: "dm-1",
      authorName: "Alice",
      content: "**hello**",
      conversationKind: "dm",
      serverName: null,
      channelName: null,
      parentChannelName: null,
      attachmentContentTypes: [],
    });
  });

  it("loads a top-level server channel and ordered attachment types", async () => {
    await expect(getPushNotificationTarget(db, "message-channel")).resolves.toEqual({
      messageId: "message-channel",
      channelId: "channel-1",
      authorName: "Alice",
      content: "**hello**",
      conversationKind: "channel",
      serverName: "Studio",
      channelName: "general",
      parentChannelName: null,
      attachmentContentTypes: ["image/png", "application/pdf"],
    });
  });

  it.each([
    ["message-thread", "thread-1", "Focused work", "general"],
    ["message-post", "post-1", "Release notes", "announcements"],
  ])(
    "loads parent and child names for %s",
    async (messageId, channelId, channelName, parentChannelName) => {
      await expect(getPushNotificationTarget(db, messageId)).resolves.toEqual({
        messageId,
        channelId,
        authorName: "Alice",
        content: "**hello**",
        conversationKind: "thread",
        serverName: "Studio",
        channelName,
        parentChannelName,
        attachmentContentTypes: [],
      });
    },
  );

  it("preserves blank and missing names for deterministic payload fallbacks", async () => {
    await expect(getPushNotificationTarget(db, "message-fallback")).resolves.toEqual({
      messageId: "message-fallback",
      channelId: "thread-blank",
      authorName: "   ",
      content: "**hello**",
      conversationKind: "thread",
      serverName: "   ",
      channelName: null,
      parentChannelName: "   ",
      attachmentContentTypes: [],
    });
  });

  it("does not filter an eligible message when parent and server rows are missing", async () => {
    await expect(getPushNotificationTarget(db, "message-orphan")).resolves.toEqual({
      messageId: "message-orphan",
      channelId: "thread-orphan",
      authorName: "Alice",
      content: "**hello**",
      conversationKind: "thread",
      serverName: null,
      channelName: "Still pushable",
      parentChannelName: null,
      attachmentContentTypes: [],
    });
  });

  it("returns null for a deleted or missing message", async () => {
    await expect(getPushNotificationTarget(db, "missing")).resolves.toBeNull();
  });
});
