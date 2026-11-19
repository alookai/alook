import { describe, expect, it } from "vitest";
import { communityWriteDb } from "../helpers/community-write-db";
import { createMigratedDb } from "../helpers/migrated-db";
import { communityChannel, communityServer } from "../../src/db/community-schema";
import { user } from "../../src/db/schema";
import * as category from "../../src/db/queries/community/category";
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

it("mutates only the requested categories and keeps reorder atomic", async () => {
  const { db, sqlite } = createMigratedDb();
  try {
    await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.test" }).run();
    await db.insert(communityServer).values([
      { id: "here", name: "Here", ownerId: "owner" },
      { id: "elsewhere", name: "Elsewhere", ownerId: "owner" },
    ]).run();
    const privateCategory = await category.createCategory(db, { name: "Private", serverId: "here", private: true, creatorId: "owner" });
    const empty = await category.createCategory(db, { name: "Empty", serverId: "here" });
    const foreign = await category.createCategory(db, { name: "Other", serverId: "elsewhere" });
    await db.insert(communityChannel).values({
      id: "channel", name: "Channel", type: "text", serverId: "here", categoryId: privateCategory.id,
    }).run();
    await expect(category.hasChannels(db, privateCategory.id)).resolves.toBe(true);
    await expect(category.hasChannels(db, empty.id)).resolves.toBe(false);
    await expect(category.updateCategory(db, privateCategory.id, { name: "Renamed" })).resolves.toMatchObject({
      id: privateCategory.id, name: "Renamed", private: 1,
    });
    const lookedUp = await category.getCategoriesByIds(db, [privateCategory.id, empty.id, privateCategory.id, "missing"]);
    expect(lookedUp.map(row => row.id).sort()).toEqual([privateCategory.id, empty.id].sort());

    await expect(category.reorderCategories(db, "here", [empty.id, privateCategory.id])).resolves.toHaveLength(2);
    const scoped = () => category.listCategoriesByServer(db, "here");
    const arranged = await scoped();
    expect(arranged.map(row => [row.id, row.position])).toEqual([[empty.id, 0], [privateCategory.id, 1]]);
    await expect(category.reorderCategories(db, "here", [privateCategory.id, foreign.id])).resolves.toEqual([]);
    await expect(category.reorderCategories(db, "here", [privateCategory.id, privateCategory.id])).resolves.toEqual([]);
    await expect(scoped()).resolves.toEqual(arranged);
    await expect(category.getCategory(db, foreign.id)).resolves.toEqual(foreign);

    await expect(category.deleteCategory(db, empty.id)).resolves.toMatchObject({ id: empty.id });
    await expect(category.getCategory(db, empty.id)).resolves.toBeNull();
    await expect(category.hasChannels(db, privateCategory.id)).resolves.toBe(true);
  } finally {
    sqlite.close();
  }
});

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
