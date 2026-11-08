import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Database } from "../../src/db"
import { listEligibleUnreadChannels, listUnreadForumOpeners, listThreadOpenersByChildIds } from "../../src/db/queries/community/inbox"

describe("listEligibleUnreadChannels", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, discriminator TEXT NOT NULL, image TEXT, deleted_at TEXT);
      CREATE TABLE community_server (id TEXT PRIMARY KEY, name TEXT NOT NULL, discriminator TEXT NOT NULL, owner_id TEXT NOT NULL, description TEXT, icon TEXT, created_at TEXT NOT NULL);
      CREATE TABLE community_server_member (id TEXT PRIMARY KEY, server_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT, rail_order INTEGER, joined_at TEXT NOT NULL);
      CREATE TABLE community_category (id TEXT PRIMARY KEY, server_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER, private INTEGER, creator_id TEXT);
      CREATE TABLE community_channel (id TEXT PRIMARY KEY, server_id TEXT, category_id TEXT, name TEXT, type TEXT NOT NULL, topic TEXT, position INTEGER, parent_channel_id TEXT, creator_id TEXT, message_count INTEGER, archived INTEGER NOT NULL, parent_message_id TEXT, last_message_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE community_channel_member (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, relation TEXT NOT NULL, source TEXT, added_by TEXT, added_at TEXT NOT NULL);
      CREATE TABLE community_message (id TEXT PRIMARY KEY, author_id TEXT NOT NULL, content TEXT NOT NULL, type TEXT, mention_type TEXT, reply_to_id TEXT, embeds TEXT, created_at TEXT NOT NULL, channel_id TEXT NOT NULL, seq INTEGER NOT NULL, friendship_id TEXT, client_nonce TEXT);
      CREATE TABLE community_read_state (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, last_read_at TEXT NOT NULL, last_read_message_id TEXT, last_read_seq INTEGER NOT NULL);
      CREATE TABLE community_notification_setting (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, server_id TEXT, channel_id TEXT, level TEXT NOT NULL);
      CREATE TABLE community_mention (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, read INTEGER NOT NULL);

      INSERT INTO user (id, name, discriminator) VALUES ('viewer', 'Viewer', '0001'), ('author', 'Author', '0002');
      INSERT INTO community_server (id, name, discriminator, owner_id, created_at) VALUES
        ('server-a', 'A', '0001', 'author', '2025-01-01T00:00:00Z'),
        ('server-b', 'B', '0002', 'author', '2025-01-01T00:00:00Z');
      INSERT INTO community_server_member (id, server_id, user_id, joined_at) VALUES
        ('member-a', 'server-a', 'viewer', '2026-01-01T00:00:00Z'),
        ('member-b', 'server-b', 'viewer', '2026-01-01T00:00:00Z');
      INSERT INTO community_category (id, server_id, name, private) VALUES
        ('private-a', 'server-a', 'private', 1);
      INSERT INTO community_channel (id, server_id, category_id, name, type, archived, created_at) VALUES
        ('channel-a', 'server-a', NULL, 'a', 'text', 0, '2026-01-01T00:00:00Z'),
        ('hidden-a', 'server-a', 'private-a', 'hidden', 'text', 0, '2026-01-01T00:00:00Z'),
        ('channel-b', 'server-b', NULL, 'b', 'text', 0, '2026-01-01T00:00:00Z'),
        ('dm', NULL, NULL, NULL, 'dm', 0, '2026-01-01T00:00:00Z');
      INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq) VALUES
        ('a-1', 'author', 'a1', '2026-01-02T00:00:00Z', 'channel-a', 1),
        ('a-2', 'author', 'a2', '2026-01-03T00:00:00Z', 'channel-a', 2),
        ('hidden-1', 'author', 'hidden', '2026-01-03T00:00:00Z', 'hidden-a', 1),
        ('b-1', 'author', 'b1', '2026-01-02T00:00:00Z', 'channel-b', 1),
        ('dm-1', 'author', 'dm', '2026-01-03T00:00:00Z', 'dm', 1);
      INSERT INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq) VALUES
        ('read-a', 'viewer', 'channel-a', '2026-01-02T00:00:00Z', 'a-1', 1),
        ('read-b', 'viewer', 'channel-b', '2026-01-02T00:00:00Z', 'b-1', 1);
    `)
    db = drizzle(sqlite) as unknown as Database
  })

  afterEach(() => sqlite.close())

  async function eligibleServerIds() {
    const rows = await listEligibleUnreadChannels(db, "viewer", ["channel-a", "channel-a-2", "channel-b"])
    expect(rows.every(row => row.channelId !== "hidden-a" && row.channelId !== "dm")).toBe(true)
    return [...new Set(rows.map(row => row.serverId))].sort()
  }

  it("returns distinct server ids from the authorized channel scope, cursor, and policy gates", async () => {
    await expect(eligibleServerIds()).resolves.toEqual(["server-a"])

    sqlite.exec(`
      INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq)
      VALUES ('b-2', 'author', 'b2', '2026-01-04T00:00:00Z', 'channel-b', 2);
    `)
    await expect(eligibleServerIds()).resolves.toEqual([
      "server-a",
      "server-b",
    ])
  })

  it("clears only from authoritative cursor/policy state", async () => {
    sqlite.exec(`
      INSERT INTO community_channel (id, server_id, category_id, name, type, archived, created_at)
      VALUES ('channel-a-2', 'server-a', NULL, 'a-2', 'text', 0, '2026-01-01T00:00:00Z');
      INSERT INTO community_message (id, author_id, content, created_at, channel_id, seq)
      VALUES ('a-second-1', 'author', 'second', '2026-01-04T00:00:00Z', 'channel-a-2', 1);
      UPDATE community_read_state SET last_read_seq = 2 WHERE id = 'read-a';
    `)
    await expect(eligibleServerIds()).resolves.toEqual(["server-a"])

    sqlite.exec(`
      INSERT INTO community_read_state (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
      VALUES ('read-a-2', 'viewer', 'channel-a-2', '2026-01-04T00:00:00Z', 'a-second-1', 1);
    `)
    await expect(eligibleServerIds()).resolves.toEqual([])

    sqlite.exec(`
      UPDATE community_read_state SET last_read_seq = 1 WHERE id = 'read-a';
      INSERT INTO community_notification_setting (id, user_id, server_id, level)
      VALUES ('mute-a', 'viewer', 'server-a', 'nothing');
    `)
    await expect(eligibleServerIds()).resolves.toEqual([])
  })
  it("uses persisted messages, strict join time without a cursor, and sequence with a cursor", async () => {
    sqlite.exec("DELETE FROM community_read_state WHERE id = 'read-a'; UPDATE community_message SET created_at = '2025-12-31T00:00:00Z' WHERE channel_id = 'channel-a'");
    expect(await listEligibleUnreadChannels(db, "viewer", ["channel-a"])).toEqual([]);
    sqlite.exec("UPDATE community_message SET created_at = '2026-01-01T00:00:00Z' WHERE channel_id = 'channel-a'");
    expect(await listEligibleUnreadChannels(db, "viewer", ["channel-a"])).toEqual([]);
    sqlite.exec("UPDATE community_message SET created_at = '2026-01-02T00:00:00Z' WHERE id = 'a-2'");
    expect(await listEligibleUnreadChannels(db, "viewer", ["channel-a"])).toEqual([expect.objectContaining({ channelId: "channel-a", type: "text", lastUnreadSeq: 2, mentionCount: 0, lastAttentionSeq: null, lastMessageAt: "2026-01-02T00:00:00Z" })]);
    sqlite.exec("INSERT INTO community_read_state(id,user_id,channel_id,last_read_at,last_read_seq) VALUES ('seq','viewer','channel-a','2026-01-04T00:00:00Z',1); UPDATE community_message SET created_at = '2025-01-01T00:00:00Z' WHERE id = 'a-2'; INSERT INTO community_mention(id,message_id,user_id,kind,read) VALUES ('mention','a-2','viewer','mention',0)");
    expect(await listEligibleUnreadChannels(db, "viewer", ["channel-a"])).toEqual([expect.objectContaining({ lastUnreadSeq: 2, lastAttentionSeq: 2, mentionCount: 1, lastMessageAt: "2025-01-01T00:00:00Z" })]);
    sqlite.exec("UPDATE community_read_state SET last_read_seq = 2 WHERE id = 'seq'");
    expect(await listEligibleUnreadChannels(db, "viewer", ["channel-a"])).toEqual([]);
  });

  it("excludes archived or empty channels and requires a thread notify relation", async () => {
    sqlite.exec("UPDATE community_channel SET archived = 1 WHERE id = 'channel-a'; INSERT INTO community_channel(id,server_id,type,archived,created_at) VALUES ('empty','server-a','text',0,'now'), ('thread','server-a','thread',0,'now'); UPDATE community_channel SET parent_channel_id = 'channel-a', parent_message_id = 'a-1' WHERE id = 'thread'; INSERT INTO community_message(id,author_id,content,created_at,channel_id,seq) VALUES ('thread-message','author','body','2026-01-02T00:00:00Z','thread',1); INSERT INTO community_channel_member(id,channel_id,user_id,relation,added_at) VALUES ('access','thread','viewer','access','now')");
    expect(await listEligibleUnreadChannels(db, "viewer", ["channel-a", "empty", "thread"])).toEqual([]);
    sqlite.exec("INSERT INTO community_channel_member(id,channel_id,user_id,relation,added_at) VALUES ('notify','thread','viewer','notify','now')");
    expect(await listEligibleUnreadChannels(db, "viewer", ["thread"])).toEqual([expect.objectContaining({ channelId: "thread", type: "thread", lastUnreadSeq: 1 })]);
    const select = vi.spyOn(db, "select");
    expect(await listEligibleUnreadChannels(db, "viewer", [])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("joins only authorized forum openers and enriches exact child roots from persisted rows", async () => {
    sqlite.exec(`
      UPDATE community_channel SET type = 'forum' WHERE id IN ('channel-a', 'channel-b');
      UPDATE community_read_state SET last_read_seq = 0 WHERE id = 'read-b';
      UPDATE community_message SET content = '  Full canonical title  ' WHERE id = 'a-1';
      UPDATE community_message SET content = '   ' WHERE id = 'a-2';
      INSERT INTO community_channel(id,server_id,type,name,parent_channel_id,parent_message_id,archived,created_at) VALUES
        ('post-one','server-a','thread','Truncated','channel-a','a-1',0,'now'),
        ('post-two','server-a','thread','Fallback title','channel-a','a-2',0,'now'),
        ('foreign-post','server-b','thread','Foreign','channel-b','b-1',0,'now');
    `);
    expect(await listUnreadForumOpeners(db, "viewer", ["channel-a"])).toEqual([{ forumChannelId: "channel-a", openerMessageId: "a-2", childChannelId: "post-two", title: "Fallback title", createdAt: "2026-01-03T00:00:00Z", openerSeq: 2 }]);
    const rows = await listThreadOpenersByChildIds(db, "viewer", ["post-one", "post-two"]);
    expect(rows).toEqual([
      expect.objectContaining({ childChannelId: "post-two", openerMessageId: "a-2", title: "Fallback title", openerUnread: true, parentChannelId: "channel-a", parentType: "forum" }),
      expect.objectContaining({ childChannelId: "post-one", openerMessageId: "a-1", title: "  Full canonical title  ", openerUnread: false, openerSeq: 1 }),
    ]);
    sqlite.exec("UPDATE community_channel SET archived = 1 WHERE id = 'post-two'");
    expect(await listUnreadForumOpeners(db, "viewer", ["channel-a"])).toEqual([]);
    const select = vi.spyOn(db, "select");
    expect(await listUnreadForumOpeners(db, "viewer", [])).toEqual([]);
    expect(await listThreadOpenersByChildIds(db, "viewer", [])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

})
