import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db";
import {
  policyAllows,
  removeChannelOverride,
  setChannelLevel,
  setServerLevel,
} from "../../src/db/queries/community/notification-setting";
import {
  notificationEligibleSql,
} from "../../src/db/queries/community/notification-eligibility";
import { communityChannel } from "../../src/db/community-schema";
import { getLatestUnreadMessageForAgent } from "../../src/db/queries/community/agent-inbox";

describe("policyAllows", () => {
  it.each([
    ["all", false, true],
    ["all", true, true],
    ["mentions", false, false],
    ["mentions", true, true],
    ["nothing", false, false],
    ["nothing", true, false],
  ] as const)("maps %s / attention=%s to %s", (level, attention, expected) => {
    expect(policyAllows(level, attention)).toBe(expected);
  });
});

describe("notification setting cursor-clear contract", () => {
  let sqlite: Sqlite.Database;
  let db: Database;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        parent_channel_id TEXT,
        type TEXT NOT NULL DEFAULT 'text'
      );
      CREATE TABLE community_message (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL DEFAULT 'author',
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE TABLE community_read_state (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_read_at TEXT NOT NULL,
        last_read_message_id TEXT,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, channel_id)
      );
      CREATE TABLE community_channel_member (
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
      CREATE TABLE community_server_member (
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        joined_at TEXT NOT NULL
      );
      CREATE TABLE community_notification_setting (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        server_id TEXT,
        channel_id TEXT,
        level TEXT NOT NULL,
        CHECK ((server_id IS NOT NULL) != (channel_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX idx_notification_setting_user_server
        ON community_notification_setting(user_id, server_id) WHERE server_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_notification_setting_user_channel
        ON community_notification_setting(user_id, channel_id) WHERE channel_id IS NOT NULL;
      CREATE TABLE community_mention (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO community_channel (id, server_id, parent_channel_id) VALUES
        ('parent', 'server', NULL),
        ('child', 'server', 'parent'),
        ('sibling', 'server', NULL),
        ('empty', 'server', NULL),
        ('dm', NULL, NULL);
      INSERT INTO community_message (id, channel_id, created_at, seq) VALUES
        ('parent-1', 'parent', '2026-01-01T00:00:01Z', 1),
        ('parent-2', 'parent', '2026-01-01T00:00:02Z', 2),
        ('child-3', 'child', '2026-01-01T00:00:03Z', 3),
        ('sibling-4', 'sibling', '2026-01-01T00:00:04Z', 4),
        ('dm-5', 'dm', '2026-01-01T00:00:05Z', 5);
      INSERT INTO community_server_member (server_id, user_id, joined_at)
      VALUES ('server', 'u', '2025-01-01T00:00:00Z');
    `);
    const betterDb = drizzle(sqlite);
    (betterDb as any).batch = async (statements: any[]) =>
      sqlite.transaction(() => statements.map((statement) => statement.run()))();
    db = betterDb as unknown as Database;
  });

  afterEach(() => sqlite.close());

  const cursors = () => sqlite.prepare(`
    SELECT channel_id, last_read_message_id, last_read_at, last_read_seq
    FROM community_read_state
    WHERE user_id = 'u'
    ORDER BY channel_id
  `).all();

  it("atomically sets a server level and clears every non-empty channel in that server", async () => {
    await setServerLevel(db, { userId: "u", serverId: "server", level: "nothing" });

    expect(cursors()).toEqual([
      { channel_id: "child", last_read_message_id: "child-3", last_read_at: "2026-01-01T00:00:03Z", last_read_seq: 3 },
      { channel_id: "parent", last_read_message_id: "parent-2", last_read_at: "2026-01-01T00:00:02Z", last_read_seq: 2 },
      { channel_id: "sibling", last_read_message_id: "sibling-4", last_read_at: "2026-01-01T00:00:04Z", last_read_seq: 4 },
    ]);
    expect(sqlite.prepare("SELECT level FROM community_notification_setting WHERE user_id='u' AND server_id='server'").get())
      .toEqual({ level: "nothing" });
  });

  it("a parent override clears the parent and its children, but not a sibling", async () => {
    await setChannelLevel(db, { userId: "u", channelId: "parent", level: "mentions" });
    expect(cursors().map((row: any) => row.channel_id)).toEqual(["child", "parent"]);
  });

  it("server changes do not clear descendants protected by a more specific override", async () => {
    sqlite.prepare(`
      INSERT INTO community_notification_setting (id, user_id, channel_id, level)
      VALUES ('child-own', 'u', 'child', 'all')
    `).run();

    await setServerLevel(db, { userId: "u", serverId: "server", level: "nothing" });
    expect(cursors().map((row: any) => row.channel_id)).toEqual(["parent", "sibling"]);
  });

  it("does not clear when an explicit override leaves the effective level unchanged", async () => {
    await setServerLevel(db, { userId: "u", serverId: "server", level: "mentions" });
    sqlite.prepare("DELETE FROM community_read_state").run();

    await setChannelLevel(db, { userId: "u", channelId: "parent", level: "mentions" });
    expect(cursors()).toEqual([]);
  });

  it("an idempotent retry preserves messages that arrived after the successful change", async () => {
    await setChannelLevel(db, { userId: "u", channelId: "parent", level: "nothing" });
    sqlite.exec(`
      INSERT INTO community_message (id, channel_id, created_at, seq) VALUES
        ('parent-6', 'parent', '2026-01-01T00:00:06Z', 6),
        ('child-7', 'child', '2026-01-01T00:00:07Z', 7);
    `);

    await setChannelLevel(db, { userId: "u", channelId: "parent", level: "nothing" });
    expect(cursors()).toEqual([
      { channel_id: "child", last_read_message_id: "child-3", last_read_at: "2026-01-01T00:00:03Z", last_read_seq: 3 },
      { channel_id: "parent", last_read_message_id: "parent-2", last_read_at: "2026-01-01T00:00:02Z", last_read_seq: 2 },
    ]);
  });

  it("a DM uses the same channel-scope setting and only clears that DM", async () => {
    await setChannelLevel(db, { userId: "u", channelId: "dm", level: "nothing" });
    expect(cursors()).toEqual([
      { channel_id: "dm", last_read_message_id: "dm-5", last_read_at: "2026-01-01T00:00:05Z", last_read_seq: 5 },
    ]);
  });

  it("empty channels never manufacture a read-state row", async () => {
    await setChannelLevel(db, { userId: "u", channelId: "empty", level: "nothing" });
    expect(cursors()).toEqual([]);
  });

  it("never regresses an already-newer aligned cursor", async () => {
    sqlite.exec(`
      INSERT INTO community_message (id, channel_id, created_at, seq)
      VALUES ('parent-9', 'parent', '2026-01-01T00:00:09Z', 9);
      INSERT INTO community_read_state
        (id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq)
      VALUES ('rs', 'u', 'parent', '2026-01-01T00:00:09Z', 'parent-9', 9);
      DELETE FROM community_message WHERE id = 'parent-9';
    `);

    await setChannelLevel(db, { userId: "u", channelId: "parent", level: "all" });
    expect(sqlite.prepare("SELECT last_read_message_id, last_read_seq FROM community_read_state WHERE id='rs'").get())
      .toEqual({ last_read_message_id: "parent-9", last_read_seq: 9 });
  });

  it("rolls the setting back when cursor advancement fails", async () => {
    sqlite.exec(`
      CREATE TRIGGER reject_read_state BEFORE INSERT ON community_read_state
      BEGIN SELECT RAISE(ABORT, 'cursor rejected'); END;
    `);

    await expect(setServerLevel(db, { userId: "u", serverId: "server", level: "nothing" }))
      .rejects.toThrow("cursor rejected");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_notification_setting").get())
      .toEqual({ count: 0 });
  });

  it("override removal also clears old unread before inheriting again", async () => {
    await setChannelLevel(db, { userId: "u", channelId: "dm", level: "nothing" });
    sqlite.prepare("DELETE FROM community_read_state").run();
    await removeChannelOverride(db, { userId: "u", channelId: "dm" });

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_notification_setting WHERE channel_id='dm'").get())
      .toEqual({ count: 0 });
    expect(cursors().map((row: any) => row.channel_id)).toEqual(["dm"]);
  });

  it("a no-op override removal preserves unread and creates no cursor", async () => {
    expect(await removeChannelOverride(db, { userId: "u", channelId: "dm" })).toBeNull();
    expect(cursors()).toEqual([]);
  });

  it("SQL eligibility uses the current override hierarchy and attention fact", async () => {
    sqlite.exec(`
      INSERT INTO community_notification_setting (id, user_id, channel_id, level)
      VALUES ('setting', 'u', 'child', 'mentions');
      INSERT INTO community_mention (id, message_id, user_id, kind)
      VALUES ('mention', 'child-3', 'u', 'mention');
    `);
    const channelSql = {
      id: communityChannel.id,
      serverId: communityChannel.serverId,
      parentChannelId: communityChannel.parentChannelId,
    };
    const row = await (db as any)
      .select({
        mentioned: notificationEligibleSql("u", channelSql, { id: sql`'child-3'` }),
        plain: notificationEligibleSql("u", channelSql, { id: sql`'plain'` }),
      })
      .from(communityChannel)
      .where(eq(communityChannel.id, "child"))
      .get();

    expect(row).toEqual({ mentioned: 1, plain: 0 });
  });

  it("resync skips the newest muted unread and finds an older eligible unread", async () => {
    sqlite.exec(`
      INSERT INTO community_message (id, channel_id, created_at, seq)
      VALUES ('parent-newest', 'parent', '2026-01-01T00:00:10Z', 10);
      INSERT INTO community_notification_setting (id, user_id, channel_id, level) VALUES
        ('mute-parent', 'u', 'parent', 'nothing'),
        ('allow-child', 'u', 'child', 'all');
    `);

    const latest = await getLatestUnreadMessageForAgent(db, "u", {
      accessVisibleChannelIds: ["parent", "child"],
    });
    expect(latest).toEqual({ messageId: "child-3" });
  });
});
