import { readFileSync } from "node:fs";
import Sqlite from "better-sqlite3";
import { expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { communityServerRail, communityServerMember, communityServerFolder } from "../../src/db/community-schema";

it("migrates legacy order without replacing mixed order or folder contents", () => {
  const db = new Sqlite(":memory:");
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE user (id TEXT PRIMARY KEY);
      CREATE TABLE community_server (id TEXT PRIMARY KEY);
      CREATE TABLE community_server_member (id TEXT PRIMARY KEY, user_id TEXT REFERENCES user(id), server_id TEXT REFERENCES community_server(id), rail_order INTEGER, joined_at TEXT);
      CREATE INDEX idx_server_member_user_rail_order ON community_server_member(user_id, rail_order);
      CREATE TABLE community_server_folder (id TEXT PRIMARY KEY, user_id TEXT REFERENCES user(id), name TEXT, position INTEGER);
      CREATE INDEX idx_server_folder_user_position ON community_server_folder(user_id, position);
      CREATE TABLE community_server_folder_item (folder_id TEXT REFERENCES community_server_folder(id), server_id TEXT REFERENCES community_server(id), position INTEGER);
      ${readFileSync(new URL("../../../web/migrations/0108_community_server_rail_order.sql", import.meta.url), "utf8")}
      INSERT INTO user VALUES ('legacy'), ('mixed');
      INSERT INTO community_server VALUES ('a'), ('b'), ('c'), ('d'), ('foreign');
      INSERT INTO community_server_member VALUES
        ('la','legacy','a',2,'2026-01-01'), ('lb','legacy','b',1,'2026-01-01'),
        ('lc','legacy','c',0,'2026-01-01'), ('ld','legacy','d',0,'2026-01-01'),
        ('ma','mixed','a',0,'2026-01-01'), ('mb','mixed','b',1,'2026-01-01');
      INSERT INTO community_server_folder VALUES
        ('later','legacy','Later',8), ('first','legacy','First',2),
        ('empty','legacy','Empty',0), ('stale','legacy','Stale',0), ('mf','mixed','Mixed',0);
      INSERT INTO community_server_folder_item VALUES ('later','c',6), ('first','d',3), ('stale','foreign',0), ('mf','b',0);
      INSERT INTO community_server_rail VALUES ('mixed','[{"kind":"folder","id":"mf"},{"kind":"server","id":"a"}]');
    `);
    const items = db.prepare("SELECT * FROM community_server_folder_item").all();
    const mixed = db.prepare("SELECT entries FROM community_server_rail WHERE user_id='mixed'").get();
    db.exec(readFileSync(new URL("../../../web/migrations/0109_server_rail_single_order.sql", import.meta.url), "utf8"));
    expect(JSON.parse((db.prepare("SELECT entries FROM community_server_rail WHERE user_id='legacy'").get() as { entries: string }).entries)).toEqual([
      { kind: "server", id: "b" }, { kind: "server", id: "a" },
      { kind: "folder", id: "first" }, { kind: "folder", id: "later" },
    ]);
    expect(db.prepare("SELECT entries FROM community_server_rail WHERE user_id='mixed'").get()).toEqual(mixed);
    expect(db.prepare("SELECT * FROM community_server_folder_item").all()).toEqual(items);
    expect(db.prepare("SELECT COUNT(*) AS count FROM community_server_member").get()).toEqual({ count: 6 });
    expect(db.prepare("PRAGMA table_info(community_server_member)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "rail_order" })]));
    expect(db.prepare("PRAGMA table_info(community_server_folder)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "position" })]));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec("INSERT INTO user VALUES ('cascade-only'); INSERT INTO community_server_rail VALUES ('cascade-only', '[]'); DELETE FROM user WHERE id='cascade-only';");
    expect(db.prepare("SELECT * FROM community_server_rail WHERE user_id='cascade-only'").get()).toBeUndefined();
    expect(() => db.prepare("INSERT INTO community_server_rail VALUES ('missing-owner', '[]')").run()).toThrow();
  } finally { db.close(); }
});

it("declares one account-owned order without legacy top-level columns", () => {
  const rail = getTableConfig(communityServerRail);
  expect(rail.columns.map((column) => column.name)).toEqual(["user_id", "entries"]);
  const owner = rail.foreignKeys[0]!;
  expect(owner.reference()).toMatchObject({ columns: [{ name: "user_id" }], foreignColumns: [{ name: "id" }] });
  expect(owner.onDelete).toBe("cascade");
  expect(getTableConfig(communityServerMember).columns.map((column) => column.name)).not.toContain("rail_order");
  const folder = getTableConfig(communityServerFolder);
  expect(folder.columns.map((column) => column.name)).not.toContain("position");
  expect(folder.indexes.map((index) => index.config.name)).toContain("idx_server_folder_user");
});
