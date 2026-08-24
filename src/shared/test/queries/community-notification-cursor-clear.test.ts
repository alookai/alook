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
  resolveNotificationEligibilityForUsers,
} from "../../src/db/queries/community/notification-eligibility";
import { communityChannel } from "../../src/db/community-schema";
import { listUserServers } from "../../src/db/queries/community/server";
import {
  getInboxSnapshotForAgent,
  getLatestUnreadMessageForAgent,
  hasDeliverableUnreadForAgentScope,
  listUnreadMessagesForAgent,
} from "../../src/db/queries/community/agent-inbox";
import { listEligibleUnreadChannels } from "../../src/db/queries/community/inbox";

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
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        discriminator TEXT NOT NULL DEFAULT '0000',
        image TEXT,
        deleted_at TEXT
      );
      INSERT INTO user (id, name, discriminator) VALUES
        ('u', 'Bot', '0001'),
        ('author', 'Human', '0002');
      CREATE TABLE community_server (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        discriminator TEXT NOT NULL DEFAULT '0000',
        description TEXT NOT NULL DEFAULT '',
        icon TEXT,
        owner_id TEXT NOT NULL DEFAULT 'author',
        created_at TEXT NOT NULL DEFAULT '2025-01-01T00:00:00Z'
      );
      INSERT INTO community_server (id, name) VALUES ('server', 'Server');
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        category_id TEXT,
        parent_channel_id TEXT,
        creator_id TEXT,
        type TEXT NOT NULL DEFAULT 'text',
        name TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT
      );
      CREATE TABLE community_category (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        private INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE community_message (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL DEFAULT 'author',
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        seq INTEGER NOT NULL,
        reply_to_id TEXT
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
      CREATE TABLE community_read_state_revision (
        user_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE community_forum_opener_read (
        user_id TEXT NOT NULL,
        opener_message_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY(user_id, opener_message_id)
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
        joined_at TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        rail_order INTEGER NOT NULL DEFAULT 0
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
      INSERT INTO community_channel_member (channel_id, user_id, relation, added_at)
      VALUES ('dm', 'u', 'access', '2025-01-01T00:00:00Z');
    `);
    const betterDb = drizzle(sqlite);
    (betterDb as any).batch = async (statements: any[]) =>
      sqlite.transaction(() => statements.map((statement) => {
        try {
          return statement.all();
        } catch (error) {
          if (error instanceof TypeError && error.message.includes("does not return data")) {
            return statement.run();
          }
          throw error;
        }
      }))();
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
    await setServerLevel(db, { userId: "u", serverId: "server", level: "nothing", actorKind: "human" });

    expect(cursors()).toEqual([
      { channel_id: "child", last_read_message_id: "child-3", last_read_at: "2026-01-01T00:00:03Z", last_read_seq: 3 },
      { channel_id: "parent", last_read_message_id: "parent-2", last_read_at: "2026-01-01T00:00:02Z", last_read_seq: 2 },
      { channel_id: "sibling", last_read_message_id: "sibling-4", last_read_at: "2026-01-01T00:00:04Z", last_read_seq: 4 },
    ]);
    expect(sqlite.prepare("SELECT level FROM community_notification_setting WHERE user_id='u' AND server_id='server'").get())
      .toEqual({ level: "nothing" });
  });

  it("keeps bot policy writes outside the human revision stream", async () => {
    const result = await setChannelLevel(db, {
      userId: "u",
      channelId: "parent",
      level: "nothing",
      actorKind: "bot",
    });

    expect(result.readStateRevision).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_read_state_revision").get())
      .toEqual({ count: 0 });
  });

  it("advances the forum baseline, prunes covered sparse rows, and versions only an effective policy change", async () => {
    sqlite.exec(`
      UPDATE community_channel SET type = 'forum' WHERE id = 'parent';
      INSERT INTO community_forum_opener_read (user_id, opener_message_id, read_at) VALUES
        ('u', 'parent-1', '2026-01-01T00:00:01Z'),
        ('u', 'parent-2', '2026-01-01T00:00:02Z'),
        ('u', 'sibling-4', '2026-01-01T00:00:04Z');
    `);

    const first = await setChannelLevel(db, {
      userId: "u",
      channelId: "parent",
      level: "nothing",
      actorKind: "human",
    });
    expect(first.readStateRevision).toBe(1);
    expect(sqlite.prepare(`
      SELECT opener_message_id FROM community_forum_opener_read
      WHERE user_id = 'u' ORDER BY opener_message_id
    `).all()).toEqual([{ opener_message_id: "sibling-4" }]);
    expect(cursors()).toContainEqual({
      channel_id: "parent",
      last_read_message_id: "parent-2",
      last_read_at: "2026-01-01T00:00:02Z",
      last_read_seq: 2,
    });

    const duplicate = await setChannelLevel(db, {
      userId: "u",
      channelId: "parent",
      level: "nothing",
      actorKind: "human",
    });
    expect(duplicate.readStateRevision).toBeNull();
    expect(sqlite.prepare(`
      SELECT revision FROM community_read_state_revision WHERE user_id = 'u'
    `).get()).toEqual({ revision: 1 });
  });

  it("does not clear a private channel the target identity cannot access", async () => {
    sqlite.exec(`
      INSERT INTO community_category (id, server_id, private) VALUES ('private', 'server', 1);
      UPDATE community_channel SET category_id = 'private', creator_id = 'author' WHERE id = 'sibling';
    `);

    await setServerLevel(db, { userId: "u", serverId: "server", level: "nothing", actorKind: "human" });
    expect(cursors().map((row: any) => row.channel_id)).toEqual(["child", "parent"]);
  });

  it("a parent override clears the parent and its children, but not a sibling", async () => {
    await setChannelLevel(db, { userId: "u", channelId: "parent", level: "mentions", actorKind: "human" });
    expect(cursors().map((row: any) => row.channel_id)).toEqual(["child", "parent"]);
  });

  it("server changes do not clear descendants protected by a more specific override", async () => {
    sqlite.prepare(`
      INSERT INTO community_notification_setting (id, user_id, channel_id, level)
      VALUES ('child-own', 'u', 'child', 'all')
    `).run();

    await setServerLevel(db, { userId: "u", serverId: "server", level: "nothing", actorKind: "human" });
    expect(cursors().map((row: any) => row.channel_id)).toEqual(["parent", "sibling"]);
  });

  it("does not clear when an explicit override leaves the effective level unchanged", async () => {
    await setServerLevel(db, { userId: "u", serverId: "server", level: "mentions", actorKind: "human" });
    sqlite.prepare("DELETE FROM community_read_state").run();

    await setChannelLevel(db, { userId: "u", channelId: "parent", level: "mentions", actorKind: "human" });
    expect(cursors()).toEqual([]);
  });

  it("an idempotent retry preserves messages that arrived after the successful change", async () => {
    await setChannelLevel(db, { userId: "u", channelId: "parent", level: "nothing", actorKind: "human" });
    sqlite.exec(`
      INSERT INTO community_message (id, channel_id, created_at, seq) VALUES
        ('parent-6', 'parent', '2026-01-01T00:00:06Z', 6),
        ('child-7', 'child', '2026-01-01T00:00:07Z', 7);
    `);

    await setChannelLevel(db, { userId: "u", channelId: "parent", level: "nothing", actorKind: "human" });
    expect(cursors()).toEqual([
      { channel_id: "child", last_read_message_id: "child-3", last_read_at: "2026-01-01T00:00:03Z", last_read_seq: 3 },
      { channel_id: "parent", last_read_message_id: "parent-2", last_read_at: "2026-01-01T00:00:02Z", last_read_seq: 2 },
    ]);
  });

  it("a DM uses the same channel-scope setting and only clears that DM", async () => {
    await setChannelLevel(db, { userId: "u", channelId: "dm", level: "nothing", actorKind: "human" });
    expect(cursors()).toEqual([
      { channel_id: "dm", last_read_message_id: "dm-5", last_read_at: "2026-01-01T00:00:05Z", last_read_seq: 5 },
    ]);
  });

  it("empty channels never manufacture a read-state row", async () => {
    await setChannelLevel(db, { userId: "u", channelId: "empty", level: "nothing", actorKind: "human" });
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

    await setChannelLevel(db, { userId: "u", channelId: "parent", level: "all", actorKind: "human" });
    expect(sqlite.prepare("SELECT last_read_message_id, last_read_seq FROM community_read_state WHERE id='rs'").get())
      .toEqual({ last_read_message_id: "parent-9", last_read_seq: 9 });
  });

  it("rolls the setting back when cursor advancement fails", async () => {
    sqlite.exec(`
      CREATE TRIGGER reject_read_state BEFORE INSERT ON community_read_state
      BEGIN SELECT RAISE(ABORT, 'cursor rejected'); END;
    `);

    await expect(setServerLevel(db, { userId: "u", serverId: "server", level: "nothing", actorKind: "human" }))
      .rejects.toThrow("cursor rejected");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_notification_setting").get())
      .toEqual({ count: 0 });
  });

  it("override removal also clears old unread before inheriting again", async () => {
    await setChannelLevel(db, { userId: "u", channelId: "dm", level: "nothing", actorKind: "human" });
    sqlite.prepare("DELETE FROM community_read_state").run();
    await removeChannelOverride(db, { userId: "u", channelId: "dm", actorKind: "human" });

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_notification_setting WHERE channel_id='dm'").get())
      .toEqual({ count: 0 });
    expect(cursors().map((row: any) => row.channel_id)).toEqual(["dm"]);
  });

  it("a no-op override removal preserves unread and creates no cursor", async () => {
    expect((await removeChannelOverride(db, { userId: "u", channelId: "dm", actorKind: "human" })).setting).toBeNull();
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

  it("rail mention badge follows policy changes and the aligned read cursor", async () => {
    sqlite.exec(`
      INSERT INTO community_mention (id, message_id, user_id, kind, read)
      VALUES ('rail-old', 'child-3', 'u', 'mention', 0);
    `);
    const railCount = async () => (await listUserServers(db, "u"))[0]?.mentions;

    await expect(railCount()).resolves.toBe(1);
    await setChannelLevel(db, { userId: "u", channelId: "child", level: "nothing", actorKind: "human" });
    await expect(railCount()).resolves.toBe(0);

    sqlite.exec(`
      INSERT INTO community_message (id, channel_id, created_at, seq)
      VALUES ('child-6', 'child', '2026-01-01T00:00:06Z', 6);
      INSERT INTO community_mention (id, message_id, user_id, kind, read)
      VALUES ('rail-muted', 'child-6', 'u', 'mention', 0);
    `);
    await expect(railCount()).resolves.toBe(0);

    await setChannelLevel(db, { userId: "u", channelId: "child", level: "mentions", actorKind: "human" });
    await expect(railCount()).resolves.toBe(0);
    sqlite.exec(`
      INSERT INTO community_message (id, channel_id, created_at, seq)
      VALUES ('child-7', 'child', '2026-01-01T00:00:07Z', 7);
      INSERT INTO community_mention (id, message_id, user_id, kind, read)
      VALUES ('rail-new', 'child-7', 'u', 'mention', 0);
    `);
    await expect(railCount()).resolves.toBe(1);
  });

  it("rail mention badge disappears immediately when private-channel access is revoked", async () => {
    sqlite.exec(`
      INSERT INTO community_category (id, server_id, private) VALUES ('private-rail', 'server', 1);
      INSERT INTO community_channel
        (id, server_id, category_id, creator_id, type, name)
      VALUES ('private-room', 'server', 'private-rail', 'author', 'text', 'private-room');
      INSERT INTO community_channel_member (channel_id, user_id, relation, added_at)
      VALUES ('private-room', 'u', 'access', '2025-01-01T00:00:00Z');
      INSERT INTO community_message (id, channel_id, created_at, seq)
      VALUES ('private-mention', 'private-room', '2026-01-01T00:00:08Z', 8);
      INSERT INTO community_mention (id, message_id, user_id, kind, read)
      VALUES ('private-mention-row', 'private-mention', 'u', 'mention', 0);
    `);
    const railCount = async () => (await listUserServers(db, "u"))[0]?.mentions;

    await expect(railCount()).resolves.toBe(1);
    sqlite.prepare(`
      DELETE FROM community_channel_member
      WHERE channel_id = 'private-room' AND user_id = 'u' AND relation = 'access'
    `).run();
    await expect(railCount()).resolves.toBe(0);
  });

  it("delivery state fails closed after private access is revoked", async () => {
    sqlite.exec(`
      INSERT INTO community_category (id, server_id, private) VALUES ('private-delivery', 'server', 1);
      INSERT INTO community_channel
        (id, server_id, category_id, creator_id, type, name)
      VALUES ('private-delivery-room', 'server', 'private-delivery', 'author', 'text', 'private-delivery-room');
      INSERT INTO community_channel_member (channel_id, user_id, relation, added_at)
      VALUES ('private-delivery-room', 'u', 'access', '2025-01-01T00:00:00Z');
      INSERT INTO community_message (id, channel_id, created_at, seq)
      VALUES ('private-delivery-message', 'private-delivery-room', '2026-01-01T00:00:08Z', 8);
    `);

    await expect(resolveNotificationEligibilityForUsers(db, ["u"], "private-delivery-message"))
      .resolves.toEqual(new Map([["u", {
        currentLevel: "all",
        hasAttention: false,
        isUnread: true,
        isReadable: true,
      }]]));

    sqlite.prepare(`
      DELETE FROM community_channel_member
      WHERE channel_id = 'private-delivery-room' AND user_id = 'u' AND relation = 'access'
    `).run();
    await expect(resolveNotificationEligibilityForUsers(db, ["u"], "private-delivery-message"))
      .resolves.toEqual(new Map([["u", {
        currentLevel: "all",
        hasAttention: false,
        isUnread: true,
        isReadable: false,
      }]]));
  });

  it("forum child badges stay policy-eligible across a cold projection", async () => {
    sqlite.exec(`
      INSERT INTO community_channel (id, server_id, parent_channel_id, type, name) VALUES
        ('forum-parent', 'server', NULL, 'forum', 'forum'),
        ('forum-child', 'server', 'forum-parent', 'thread', 'post');
      INSERT INTO community_channel_member (channel_id, user_id, relation, added_at)
      VALUES ('forum-child', 'u', 'notify', '2025-01-01T00:00:00Z');
    `);
    await setChannelLevel(db, { userId: "u", channelId: "forum-child", level: "mentions", actorKind: "human" });
    sqlite.exec(`
      INSERT INTO community_message (id, channel_id, created_at, seq, content)
      VALUES ('forum-normal', 'forum-child', '2026-01-01T00:00:01Z', 1, 'normal');
    `);
    await expect(listEligibleUnreadChannels(db, "u", ["forum-child"])).resolves.toEqual([]);

    sqlite.exec(`
      INSERT INTO community_message (id, channel_id, created_at, seq, content)
      VALUES ('forum-mention', 'forum-child', '2026-01-01T00:00:02Z', 2, '@u');
      INSERT INTO community_mention (id, message_id, user_id, kind, read)
      VALUES ('forum-mention-row', 'forum-mention', 'u', 'mention', 0);
    `);
    await expect(listEligibleUnreadChannels(db, "u", ["forum-child"]))
      .resolves.toEqual([expect.objectContaining({ channelId: "forum-child", mentionCount: 1 })]);
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

  it("filters before page limits and keeps pull, snapshot, alignment, and web summaries identical", async () => {
    sqlite.exec(`
      INSERT INTO community_channel
        (id, server_id, parent_channel_id, type, name, last_message_at)
      VALUES
        ('a_muted', 'server', NULL, 'text', 'muted', '2026-01-01T00:03:00Z'),
        ('z_eligible', 'server', NULL, 'text', 'eligible', '2026-01-01T00:02:00Z');
      INSERT INTO community_notification_setting (id, user_id, channel_id, level)
      VALUES ('mute', 'u', 'a_muted', 'nothing');
      INSERT INTO community_message
        (id, author_id, channel_id, seq, created_at, content)
      VALUES
        ('muted_newer', 'author', 'a_muted', 1, '2026-01-01T00:03:00Z', 'muted'),
        ('eligible_older', 'author', 'z_eligible', 1, '2026-01-01T00:02:00Z', 'eligible'),
        ('eligible_second', 'author', 'z_eligible', 2, '2026-01-01T00:02:30Z', 'eligible 2');
      INSERT INTO community_mention (id, message_id, user_id, kind, read)
      VALUES
        ('dismissed_reply', 'eligible_older', 'u', 'reply', 1),
        ('active_mention', 'eligible_second', 'u', 'mention', 0);
    `);
    const insertMuted = sqlite.prepare(`
      INSERT INTO community_message (id, author_id, channel_id, seq, created_at, content)
      VALUES (?, 'author', 'a_muted', ?, '2026-01-01T00:03:00Z', 'muted')
    `);
    sqlite.transaction(() => {
      for (let seq = 2; seq <= 200; seq += 1) insertMuted.run(`muted_${seq}`, seq);
    })();

    const visible = ["a_muted", "z_eligible"];
    await expect(listUnreadMessagesForAgent(db, "u", {
      max: 1,
      visibleChannelIds: visible,
    })).resolves.toMatchObject([{ id: "eligible_older", channelId: "z_eligible" }]);
    await expect(listUnreadMessagesForAgent(db, "u", {
      max: 2,
      visibleChannelIds: visible,
    })).resolves.toMatchObject([
      { id: "eligible_older", channelId: "z_eligible" },
      { id: "eligible_second", channelId: "z_eligible" },
    ]);

    await expect(getInboxSnapshotForAgent(db, "u", {
      accessVisibleChannelIds: visible,
    })).resolves.toEqual([{
      channelId: "z_eligible",
      pendingCount: 2,
      firstPendingSeq: 1,
      latestSeq: 2,
      latestSender: "@Human#0002",
      hasMention: true,
    }]);

    await expect(hasDeliverableUnreadForAgentScope(db, "u", "a_muted", 0))
      .resolves.toBe(false);
    await expect(hasDeliverableUnreadForAgentScope(db, "u", "z_eligible", 0))
      .resolves.toBe(true);

    await expect(listEligibleUnreadChannels(db, "u", visible)).resolves.toEqual([
      expect.objectContaining({
        channelId: "z_eligible",
        lastMessageAt: "2026-01-01T00:02:30Z",
        mentionCount: 1,
      }),
    ]);
  });
});
