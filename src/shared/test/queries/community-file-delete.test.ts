import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db";
import { deleteChannelWithMedia, deleteServerWithMedia } from "../../src/db/queries/community/delete-media";
import { deleteForumPost } from "../../src/db/queries/community/forum-post-delete";

describe("community file deletion with migrated SQLite", () => {
  let sqlite: Sqlite.Database;
  let db: Database;
  const now = "2026-10-10T00:00:00.000Z";
  const run = (statement: string) => sqlite.exec(statement);
  const rows = (table: string) => sqlite.prepare("SELECT * FROM " + table).all();

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    const migrationRoot = resolve(import.meta.dirname, "../../../web/migrations");
    for (const filename of readdirSync(migrationRoot).filter(name => name.endsWith(".sql")).sort()) {
      sqlite.exec(readFileSync(resolve(migrationRoot, filename), "utf8"));
    }
    sqlite.pragma("foreign_keys = ON");
    const orm = drizzle(sqlite);
    Object.assign(orm, {
      batch: async (statements: Array<{ config: { returning?: unknown }; all: () => unknown[]; run: () => unknown }>) =>
        sqlite.transaction(() => statements.map(statement => statement.config.returning ? statement.all() : statement.run()))(),
    });
    db = orm as unknown as Database;
    run("INSERT INTO user (id,email,name,discriminator) VALUES ('owner','owner@test.example','Owner','8101'),('reader','reader@test.example','Reader','8102')");
    sqlite.prepare("INSERT INTO community_server (id,name,discriminator,owner_id,icon,created_at) VALUES ('source','Source','8201','owner','servers/source/icon',?),('destination','Destination','8202','owner',NULL,?)").run(now, now);
    sqlite.prepare("INSERT INTO community_channel (id,server_id,name,type,created_at) VALUES ('source-channel','source','Source','text',?),('destination-channel','destination','Destination','text',?)").run(now, now);
    sqlite.prepare("INSERT INTO community_message (id,author_id,content,created_at,channel_id,seq) VALUES ('source-message','owner','source',?,'source-channel',1),('destination-message','reader','copy',?,'destination-channel',1)").run(now, now);
    sqlite.prepare("INSERT INTO community_attachment (id,uploader_id,r2_key,thumbnail_r2_key,filename,created_at) VALUES ('copied','owner','attachments/shared','thumb/shared','copied.png',?),('last-reference','owner','attachments/shared','thumb/shared','last.png',?),('draft','owner','attachments/shared','thumb/shared','draft.png',?)").run(now, now, now);
    run("INSERT INTO community_message_attachment VALUES ('source-message','copied',0),('source-message','last-reference',1),('destination-message','copied',0)");
  });

  afterEach(() => sqlite.close());

  function assertRetainedFiles() {
    expect(rows("community_attachment").map(row => (row as { id: string }).id).sort()).toEqual(["copied", "draft"]);
    expect(rows("community_message_attachment")).toEqual([{ message_id: "destination-message", attachment_id: "copied", position: 0 }]);
    expect(sqlite.prepare("SELECT id FROM community_message").all()).toEqual([{ id: "destination-message" }]);
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }

  it.each(["channel", "server"] as const)("deleting a %s preserves copies and drafts; advances readers only once", async kind => {
    sqlite.prepare("INSERT INTO community_read_state (id,user_id,channel_id,last_read_message_id,last_read_seq,last_read_at) VALUES ('read','reader','source-channel','source-message',1,?)").run(now);
    const deleteRoot = () => kind === "channel"
      ? deleteChannelWithMedia(db, { channelId: "source-channel", serverId: "source" })
      : deleteServerWithMedia(db, { serverId: "source", ownerId: "owner" });
    const wrongScope = kind === "channel"
      ? await deleteChannelWithMedia(db, { channelId: "source-channel", serverId: "destination" })
      : await deleteServerWithMedia(db, { serverId: "source", ownerId: "reader" });
    expect(wrongScope).toMatchObject({ deleted: false, mediaKeys: [], readStateRevisions: [] });
    expect(rows("community_attachment")).toHaveLength(3);
    expect(await deleteRoot()).toMatchObject({ deleted: true, mediaKeys: [], readStateRevisions: [{ userId: "reader", revision: 1 }] });
    if (kind === "server") expect(sqlite.prepare("SELECT id FROM community_server").all()).toEqual([{ id: "destination" }]);
    assertRetainedFiles();
    expect(rows("community_read_state")).toEqual([]);
    expect(await deleteRoot()).toMatchObject({ deleted: false, mediaKeys: [], readStateRevisions: [] });
    expect(rows("community_read_state_revision")).toEqual([{ user_id: "reader", revision: 1 }]);
  });

  it.each([false, true])("forum deletion repairs prior cursor=%s and cascades its sole files without deleting a copy", async hasPrior => {
    run("UPDATE community_channel SET type='forum',message_count=2 WHERE id='source-channel'");
    run("UPDATE community_message SET seq=2 WHERE id='source-message'");
    if (hasPrior) sqlite.prepare("INSERT INTO community_message (id,author_id,content,created_at,channel_id,seq) VALUES ('prior','owner','prior',?,'source-channel',1)").run(now);
    sqlite.prepare("INSERT INTO community_channel (id,server_id,name,type,parent_channel_id,parent_message_id,created_at) VALUES ('child','source','Post','thread','source-channel','source-message',?)").run(now);
    sqlite.prepare("INSERT INTO community_message (id,author_id,content,created_at,channel_id,seq) VALUES ('body','owner','body',?,'child',1)").run(now);
    run("INSERT INTO community_message_attachment VALUES ('body','last-reference',0)");
    sqlite.prepare("INSERT INTO community_read_state (id,user_id,channel_id,last_read_message_id,last_read_seq,last_read_at) VALUES ('parent-read','reader','source-channel','source-message',2,?),('child-read','reader','child','body',1,?)").run(now, now);
    const input = { openerId: "source-message", openerSeq: 2, forumChannelId: "source-channel", childChannelId: "child" };
    expect(await deleteForumPost(db, input)).toEqual({ deleted: true, mediaKeys: [], readStateRevisions: [{ userId: "reader", revision: 1 }] });
    expect(rows("community_attachment").map(row => (row as { id: string }).id).sort()).toEqual(["copied", "draft"]);
    expect(rows("community_message_attachment")).toEqual([{ message_id: "destination-message", attachment_id: "copied", position: 0 }]);
    expect(sqlite.prepare("SELECT id FROM community_channel WHERE id='child'").all()).toEqual([]);
    expect(sqlite.prepare("SELECT message_count FROM community_channel WHERE id='source-channel'").get()).toEqual({ message_count: 1 });
    expect(rows("community_read_state")).toEqual(hasPrior ? [{
      id: "parent-read", user_id: "reader", channel_id: "source-channel",
      last_read_message_id: "prior", last_read_seq: 1, last_read_at: now,
    }] : []);
    expect(await deleteForumPost(db, input)).toEqual({ deleted: false, mediaKeys: [], readStateRevisions: [] });
    expect(rows("community_read_state_revision")).toEqual([{ user_id: "reader", revision: 1 }]);
    expect(sqlite.prepare("SELECT message_count FROM community_channel WHERE id='source-channel'").get()).toEqual({ message_count: 1 });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
