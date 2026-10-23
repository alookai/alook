import { describe, expect, it } from "vitest";
import { communityWriteDb } from "../helpers/community-write-db";
import { getServerRootChannelsByIds, reorderChannels } from "../../src/db/queries/community/channel";
import { channelReorderRequestSchema } from "../../src/community-channel-order";

function fixture() {
  const f = communityWriteDb();
  f.sqlite.exec(`
    INSERT INTO community_category (id, private) VALUES ('a',1),('b',1);
    INSERT INTO community_channel (id,server_id,category_id,name,position,created_at) VALUES
      ('c1','s1','a','one',0,'now'),('c2','s1','b','two',1,'now'),('c3','s1','b','three',2,'now'),('foreign','s2',NULL,'foreign',7,'now');
    INSERT INTO community_channel (id,server_id,name,type,parent_channel_id,position,created_at) VALUES ('child','s1','child','thread','c1',9,'now');
    INSERT INTO community_channel_member (id,channel_id,user_id,added_at) VALUES ('roster','c1','peer','now');
  `);
  return f;
}
const order = (sqlite: ReturnType<typeof fixture>["sqlite"]) => sqlite.prepare("SELECT id,server_id,category_id,position FROM community_channel ORDER BY id").all();

describe("atomic server channel order", () => {
  it("updates the category and exact positions in one transaction, preserving private membership", async () => {
    const { sqlite, db, batchSizes } = fixture();
    try {
      const members = sqlite.prepare("SELECT * FROM community_channel_member").all();
      await reorderChannels(db, "s1", ["c2", "c1", "c3"], { channelId: "c1", categoryId: "b" });
      expect(sqlite.prepare("SELECT id,category_id FROM community_channel WHERE server_id='s1' AND parent_channel_id IS NULL ORDER BY position").all()).toEqual([
        { id: "c2", category_id: "b" }, { id: "c1", category_id: "b" }, { id: "c3", category_id: "b" },
      ]);
      expect(batchSizes).toHaveLength(1);
      expect(batchSizes[0]).toHaveLength(3);
      expect(sqlite.prepare("SELECT * FROM community_channel_member").all()).toEqual(members);
    } finally { sqlite.close(); }
  });
  it("restores all fields when a later order statement aborts", async () => {
    const { sqlite, db, batchSizes } = fixture();
    try {
      const before = order(sqlite);
      sqlite.exec("CREATE TRIGGER reject_order BEFORE UPDATE OF position ON community_channel WHEN OLD.id='c3' BEGIN SELECT RAISE(ABORT,'order rejected'); END;");
      await expect(reorderChannels(db, "s1", ["c2", "c1", "c3"], { channelId: "c1", categoryId: "b" })).rejects.toThrow("order rejected");
      expect(order(sqlite)).toEqual(before);
      expect(batchSizes).toHaveLength(1);
    } finally { sqlite.close(); }
  });
  it("scopes reads and writes to server roots, including more than100 requested identities", async () => {
    const { sqlite, db } = fixture();
    try {
      const insert = sqlite.prepare("INSERT INTO community_channel(id,server_id,name,created_at) VALUES (?,'s1',?,'now')");
      const ids = Array.from({ length: 125 }, (_, i) => `root-${i}`);
      for (const id of ids) insert.run(id, id);
      const actual = await getServerRootChannelsByIds(db, "s1", [...ids, "c1", "foreign", "child", "missing"]);
      expect(actual.map((channel) => channel.id).sort()).toEqual([...ids, "c1"].sort());
      await reorderChannels(db, "s1", ["foreign", "c1", "child"]);
      expect(sqlite.prepare("SELECT position FROM community_channel WHERE id='foreign'").get()).toEqual({ position: 7 });
      expect(sqlite.prepare("SELECT position FROM community_channel WHERE id='child'").get()).toEqual({ position: 9 });
      expect(sqlite.prepare("SELECT position FROM community_channel WHERE id='c1'").get()).toEqual({ position: 1 });
    } finally { sqlite.close(); }
  });
  it("does no batch for an empty internal request", async () => {
    const { sqlite, db, batchSizes } = fixture();
    try {
      await reorderChannels(db, "s1", []);
      expect(await getServerRootChannelsByIds(db, "s1", [])).toEqual([]);
      expect(batchSizes).toEqual([]);
    } finally { sqlite.close(); }
  });
});

it("validates one optional included category move without changing the existing reorder shape", () => {
  expect(channelReorderRequestSchema.parse({ channelIds: ["a"] })).toEqual({ channelIds: ["a"] });
  expect(channelReorderRequestSchema.parse({ channelIds: ["a"], move: { channelId: "a", categoryId: null } }).move).toEqual({ channelId: "a", categoryId: null });
  for (const request of [{ channelIds: ["a","a"] }, { channelIds: [""] }, { channelIds: [] }, { channelIds: ["a"], move: { channelId: "b", categoryId: "c" } }, { channelIds: ["a"], move: { channelId: "a", categoryId: "c", other: true } }]) {
    expect(channelReorderRequestSchema.safeParse(request).success).toBe(false);
  }
});
