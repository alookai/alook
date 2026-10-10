import Sqlite from "better-sqlite3";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { communityMessageAttachment } from "../../src/db/community-schema";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../web/migrations/0106_community_attachment_reuse.sql", import.meta.url), "utf8");
function oldDatabase() {
  const db = new Sqlite(":memory:"); db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE community_message (id TEXT PRIMARY KEY);
    INSERT INTO community_message VALUES ('source'), ('destination');
    CREATE TABLE community_attachment (
      id TEXT PRIMARY KEY, message_id TEXT REFERENCES community_message(id) ON DELETE CASCADE,
      uploader_id TEXT NOT NULL, target_id TEXT NOT NULL, r2_key TEXT NOT NULL,
      filename TEXT NOT NULL, content_type TEXT, size INTEGER, width INTEGER, height INTEGER,
      position INTEGER, created_at TEXT NOT NULL, thumbnail_r2_key TEXT
    );
    INSERT INTO community_attachment VALUES
      ('b','source','u','channel','old/b','b.pdf','application/pdf',2,NULL,NULL,1,'now',NULL),
      ('a','source','u','channel','old/a','a.png','image/png',1,10,20,0,'now','old/a.thumb'),
      ('draft',NULL,'u','channel','old/draft','unsent.txt','text/plain',3,NULL,NULL,NULL,'now',NULL);
  `);
  return db;
}

describe("attachment schema migration preserves file identity", () => {
  it("preserves all metadata, ordering and drafts; last-reference deletion cascades only the file with no remaining references", () => {
    const db = oldDatabase();
    try {
      const before = db.prepare("SELECT id,uploader_id,r2_key,thumbnail_r2_key,filename,content_type,size,width,height,created_at FROM community_attachment ORDER BY id").all();
      db.transaction(() => db.exec(migration))();
      const declaredForeignKeys = getTableConfig(communityMessageAttachment).foreignKeys.map((key) => {
        const reference = key.reference();
        return { from: reference.columns[0].name, table: getTableName(reference.foreignTable),
          to: reference.foreignColumns[0].name, on_delete: key.onDelete?.toUpperCase() };
      }).sort((a, b) => a.from.localeCompare(b.from));
      const migratedForeignKeys = (db.pragma("foreign_key_list(community_message_attachment)") as Array<{
        from: string; table: string; to: string; on_delete: string;
      }>).map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete }))
        .sort((a, b) => a.from.localeCompare(b.from));
      expect(migratedForeignKeys).toEqual(declaredForeignKeys);
      expect(db.prepare("SELECT * FROM community_attachment ORDER BY id").all()).toEqual(before);
      expect(db.prepare("SELECT * FROM community_message_attachment ORDER BY position").all()).toEqual([
        { message_id: "source", attachment_id: "a", position: 0 },
        { message_id: "source", attachment_id: "b", position: 1 },
      ]);
      db.exec("INSERT INTO community_message_attachment VALUES ('destination','a',0)");
      expect(() => db.exec("DELETE FROM community_attachment WHERE id = 'a'")).toThrow();
      db.exec("DELETE FROM community_message WHERE id = 'source'");
      expect(db.prepare("SELECT id FROM community_attachment ORDER BY id").all()).toEqual([{ id: "a" }, { id: "draft" }]);
      db.exec("DELETE FROM community_message WHERE id = 'destination'");
      expect(db.prepare("SELECT id FROM community_attachment").all()).toEqual([{ id: "draft" }]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });

  it("an invalid old ordering rolls back the complete schema migration; backup restore remains possible before writes resume", () => {
    const db = oldDatabase();
    try {
      db.exec("UPDATE community_attachment SET position = 0 WHERE id = 'b'");
      const before = db.prepare("SELECT * FROM community_attachment ORDER BY id").all();
      expect(() => db.transaction(() => db.exec(migration))()).toThrow();
      expect(db.prepare("SELECT * FROM community_attachment ORDER BY id").all()).toEqual(before);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'community_message_attachment'").all()).toEqual([]);
      db.exec("UPDATE community_attachment SET position = 1 WHERE id = 'b'");
      db.transaction(() => db.exec(migration))();
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });
});
