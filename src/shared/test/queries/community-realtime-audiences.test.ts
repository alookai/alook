import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db";
import { resolveChannelContentRecipientUserIds, resolveChannelNotificationRecipientUserIds } from "../../src/db/queries/community/members-resolver";
import { filterChannelReadableUserIds, listReadableChannelsForUser, getReadableMessageChannelId } from "../../src/db/queries/community/channel";

describe("realtime channel audiences with canonical SQLite permissions", () => {
  let sqlite: Sqlite.Database;
  let db: Database;
  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY);
      CREATE TABLE community_server_member (id TEXT PRIMARY KEY, server_id TEXT, user_id TEXT, role TEXT);
      CREATE TABLE community_category (id TEXT PRIMARY KEY, private INTEGER);
      CREATE TABLE community_channel (id TEXT PRIMARY KEY, server_id TEXT, category_id TEXT, type TEXT, parent_channel_id TEXT, creator_id TEXT);
      CREATE TABLE community_channel_member (id TEXT PRIMARY KEY, channel_id TEXT, user_id TEXT, relation TEXT);
      CREATE TABLE community_message (id TEXT PRIMARY KEY, channel_id TEXT);
      INSERT INTO user VALUES ('author'),('participant'),('reader'),('admin'),('outsider'),('departed');
      INSERT INTO community_server_member VALUES ('a','server','author','owner'),('p','server','participant','member'),('r','server','reader','member'),('x','server','admin','admin');
      INSERT INTO community_category VALUES ('private',1),('public',0);
      INSERT INTO community_channel VALUES
        ('text','server','public','text',NULL,'author'),
        ('forum','server','public','forum',NULL,'author'),
        ('private-text','server','private','text',NULL,'author'),
        ('private-forum','server','private','forum',NULL,'author'),
        ('thread','server',NULL,'thread','text','author'),
        ('post','server',NULL,'thread','forum','author'),
        ('private-thread','server',NULL,'thread','private-text','author'),
        ('private-post','server',NULL,'thread','private-forum','author'),
        ('dm',NULL,NULL,'dm',NULL,'author');
      INSERT INTO community_channel_member VALUES
        ('ptp','private-text','participant','access'),('ptr','private-text','reader','access'),('ptd','private-text','departed','access'),
        ('pfp','private-forum','participant','access'),('pfr','private-forum','reader','access'),
        ('t','thread','participant','notify'),('p','post','participant','notify'),
        ('pt','private-thread','participant','notify'),('pp','private-post','participant','notify'),
        ('stale','private-thread','outsider','notify'),
        ('da','dm','author','access'),('dr','dm','reader','access');
      INSERT INTO community_message VALUES ('message','private-thread');
    `);
    db = drizzle(sqlite) as unknown as Database;
  });
  afterEach(() => sqlite.close());

  it.each(["thread", "post", "private-thread", "private-post"])("%s delivers content to readable nonparticipants", async (id) => {
    const content = await resolveChannelContentRecipientUserIds(db, id);
    expect(content).toContain("reader");
    expect(content).toContain("author");
    expect(content).not.toContain("outsider");
    expect(content).not.toContain("departed");
    expect(content.includes("admin")).toBe(!id.startsWith("private"));
    expect(await resolveChannelNotificationRecipientUserIds(db, id)).not.toContain("reader");
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_channel_member WHERE channel_id=? AND user_id='reader'").get(id)).toEqual({ n: 0 });
  });

  it("keeps DM pair and missing/unknown scopes closed", async () => {
    expect(await resolveChannelContentRecipientUserIds(db, "dm")).toEqual(["author", "reader"]);
    expect(await resolveChannelContentRecipientUserIds(db, "missing")).toEqual([]);
    sqlite.prepare("UPDATE community_channel SET type='future' WHERE id='text'").run();
    expect(await resolveChannelContentRecipientUserIds(db, "text")).toEqual([]);
  });

  it("rechecks parent access and server membership for delayed target checks", async () => {
    expect(await getReadableMessageChannelId(db, "reader", "message")).toBe("private-thread");
    sqlite.prepare("DELETE FROM community_channel_member WHERE channel_id='private-text' AND user_id='reader'").run();
    expect(await listReadableChannelsForUser(db, "reader", ["private-thread", "private-text"])).toEqual([]);
    expect(await getReadableMessageChannelId(db, "reader", "message")).toBeNull();
    sqlite.prepare("DELETE FROM community_server_member WHERE user_id='author'").run();
    expect(await filterChannelReadableUserIds(db, "private-thread", ["author", "reader", "participant", "participant"])).toEqual(["participant"]);
  });

  it("leaving participation preserves content and batched visibility matches membership", async () => {
    sqlite.prepare("DELETE FROM community_channel_member WHERE channel_id='private-post' AND relation='notify'").run();
    expect(await resolveChannelNotificationRecipientUserIds(db, "private-post")).toEqual([]);
    expect(await resolveChannelContentRecipientUserIds(db, "private-post")).toContain("participant");
    expect(await listReadableChannelsForUser(db, "reader", ["private-thread", "post", "missing", "post"])).toHaveLength(2);
    expect(await filterChannelReadableUserIds(db, "thread", [])).toEqual([]);
  });

  it("chunks a large readable audience without dropping or duplicating users", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `reader-${i}`);
    for (const id of ids) {
      sqlite.prepare("INSERT INTO user VALUES (?)").run(id);
      sqlite.prepare("INSERT INTO community_server_member VALUES (?, 'server', ?, 'member')").run(id, id);
    }
    expect(await filterChannelReadableUserIds(db, "thread", [...ids, ...ids])).toEqual(ids);
  });
});
