import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as coreSchema from "../../src/db/schema";
import * as communitySchema from "../../src/db/community-schema";
import type { Database } from "../../src/db";
import { getPushNotificationTarget } from "../../src/db/queries/community/notification-target";
import {
  DECISION_CARD_EMBED_KIND,
  DecisionCardEmbedSchema,
  DecisionCardInputSchema,
  buildDecisionCardEmbed,
} from "../../src/community-decision-card";
import { buildCommunityNotificationCopy } from "../../src/utils/community-notification-copy";

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
        channel_id TEXT NOT NULL,
        type TEXT, friendship_id TEXT, embeds TEXT
      );
      CREATE TABLE community_attachment (
        id TEXT PRIMARY KEY NOT NULL,
        content_type TEXT,
        filename TEXT NOT NULL DEFAULT '', size INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE community_bot_creation_request (id TEXT PRIMARY KEY, message_id TEXT);
      CREATE TABLE community_message_attachment (message_id TEXT, attachment_id TEXT, position INTEGER);
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
        (id, content_type, created_at)
        VALUES
        ('attachment-2', 'application/pdf', '2026-09-12T00:00:01.000Z'),
        ('attachment-1', 'image/png', '2026-09-12T00:00:00.000Z');
      INSERT INTO community_message_attachment VALUES ('message-channel', 'attachment-2', 1), ('message-channel', 'attachment-1', 0);
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
      attachments: [],
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
      attachments: [{ id: "attachment-1", name: "", contentType: "image/png", sizeBytes: null }, { id: "attachment-2", name: "", contentType: "application/pdf", sizeBytes: null }],
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
        attachments: [],
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
      attachments: [],
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
      attachments: [],
    });
  });

  it("parses JSON string embeds so decision card notifications render the short summary (including legacy cards without summary)", async () => {
    const newCard = buildDecisionCardEmbed(
      DecisionCardInputSchema.parse({
        summary: "定一下时间",
        questions: [{ question: "哪天开会？", options: [{ label: "周四", recommended: true }, { label: "周五" }] }],
      }),
      [{ userId: "u_gus", handle: "gus#1813" }],
    );
    sqlite.prepare(
      "INSERT INTO community_message (id, author_id, content, channel_id, type, embeds) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("message-question", "author-1", "定一下时间", "channel-1", "question", JSON.stringify([newCard]));

    const target = await getPushNotificationTarget(db, "message-question");
    expect(target?.embeds).toEqual([newCard]);
    expect(buildCommunityNotificationCopy(target!)).toEqual({
      title: "Studio · #general",
      body: "Alice: 定一下时间",
    });

    const legacyCard = DecisionCardEmbedSchema.parse({
      kind: DECISION_CARD_EMBED_KIND,
      version: 1,
      assignees: [{ userId: "u_gus", handle: "gus#1813" }],
      questions: [
        {
          id: "q1",
          question: "哪天开会？",
          multiSelect: false,
          allowOther: true,
          options: [{ id: "o1", label: "周四", recommended: true }, { id: "o2", label: "周五" }],
        },
      ],
    });
    sqlite.prepare(
      "INSERT INTO community_message (id, author_id, content, channel_id, type, embeds) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("message-question-legacy", "author-1", "@gus#1813 legacy verbose\n周四 / 周五", "channel-1", "question", JSON.stringify([legacyCard]));

    const legacyTarget = await getPushNotificationTarget(db, "message-question-legacy");
    expect(legacyTarget?.embeds).toEqual([legacyCard]);
    expect(buildCommunityNotificationCopy(legacyTarget!)).toEqual({
      title: "Studio · #general",
      body: "Alice: 哪天开会？",
    });
  });

  it("returns null for a deleted or missing message", async () => {
    await expect(getPushNotificationTarget(db, "missing")).resolves.toBeNull();
  });
});
