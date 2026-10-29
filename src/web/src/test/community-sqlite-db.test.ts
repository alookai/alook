import { readFileSync } from "node:fs"
import { afterEach, expect, it } from "vitest"
import { createRequire } from "node:module"
import { queries } from "@alook/shared"
import { user } from "../../../shared/src/db/schema"
import { createCommunitySqliteDb } from "./community-sqlite-db"

const { eq } = createRequire(import.meta.resolve("@alook/shared"))("drizzle-orm") as { eq: (column: typeof user.id, value: string) => ReturnType<typeof user.id.getSQL> }
const stores: ReturnType<typeof createCommunitySqliteDb>[] = []
afterEach(() => { for (const store of stores) store.sqlite.close(); stores.length = 0 })
function fixture() {
  const store = createCommunitySqliteDb(); stores.push(store)
  store.sqlite.exec("INSERT INTO user (id,name,email,discriminator,\"avatarVersion\",\"isBot\",\"ownerUserId\") VALUES ('viewer','Viewer','viewer@example.test','0042',0,0,null),('bot','Bot','bot@example.test','0043',0,1,'viewer')")
  store.sqlite.exec("INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at) VALUES ('server','Server','0044','','viewer','2026-10-29T00:00:00Z')")
  store.sqlite.exec("INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('viewer-member','server','viewer','owner'),('bot-member','server','bot','member')")
  store.sqlite.exec("INSERT INTO community_channel (id,server_id,name,type,topic,position,archived,message_count,created_at) VALUES ('channel','server','Channel','text','',0,0,0,'2026-10-29T00:00:00Z')")
  return store
}
it("retains the actual migration's two notification partial unique constraints", () => {
  const { sqlite } = fixture()
  const migration = readFileSync(new URL("../../migrations/0068_dm_to_channel.sql", import.meta.url), "utf8")
  const statements = migration.split("\n").filter(line => line.startsWith("CREATE UNIQUE INDEX idx_notification_setting_user_"))
  expect(statements).toHaveLength(2)
  for (const sql of statements) {
    const name = /^CREATE UNIQUE INDEX (\S+)/.exec(sql)![1]
    expect(sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)).toMatchObject({ sql: sql.replace(/;$/, "") })
  }
})
it("implements the public unmapped D1 all contract with actual ORM SQL, named columns and parameter binding", async () => {
  const { db, record } = fixture()
  const selected = (id: string) => db.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, id)).getSQL()
  expect(await db.all(selected("viewer"))).toEqual([{ id: "viewer", name: "Viewer" }])
  expect(await db.all(selected("absent"))).toEqual([])
  expect(record.statements.map(row => row.bindings)).toEqual([["viewer"], ["absent"]])
  expect(record.invocations).toBe(2)
})
it("persists a real bot notification upsert and update without a human read-state revision", async () => {
  const { db, sqlite, record } = fixture()
  const first = await queries.communityNotificationSetting.setChannelLevel(db, { userId: "bot", channelId: "channel", level: "mentions", actorKind: "bot" })
  const second = await queries.communityNotificationSetting.setChannelLevel(db, { userId: "bot", channelId: "channel", level: "nothing", actorKind: "bot" })
  expect(first).toMatchObject({ setting: { userId: "bot", channelId: "channel", level: "mentions" }, readStateRevision: null })
  expect(second).toMatchObject({ setting: { id: first.setting.id, level: "nothing" }, readStateRevision: null })
  expect(await queries.communityNotificationSetting.getChannelSetting(db, "bot", "channel")).toMatchObject({ id: first.setting.id, level: "nothing" })
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_notification_setting").get()).toMatchObject({ count: 1 })
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_read_state_revision").get()).toMatchObject({ count: 0 })
  expect(record.batches).toEqual([])
})
it("rolls back a real human policy batch after the first write and accepts the same input after storage recovers", async () => {
  const { db, sqlite, record } = fixture()
  sqlite.exec("CREATE TRIGGER reject_setting BEFORE INSERT ON community_notification_setting BEGIN SELECT RAISE(ABORT,'test setting storage rejection'); END")
  const before = (sqlite.prepare("SELECT total_changes() AS count").get() as { count: number }).count
  await expect(queries.communityNotificationSetting.setChannelLevel(db, { userId: "viewer", channelId: "channel", level: "nothing", actorKind: "human" })).rejects.toThrow()
  expect((sqlite.prepare("SELECT total_changes() AS count").get() as { count: number }).count).toBeGreaterThan(before)
  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_read_state_revision").get()).toMatchObject({ count: 0 })
  expect(await queries.communityNotificationSetting.getChannelSetting(db, "viewer", "channel")).toBeNull()
  expect(record.batches).toEqual([3])
  sqlite.exec("DROP TRIGGER reject_setting")
  const accepted = await queries.communityNotificationSetting.setChannelLevel(db, { userId: "viewer", channelId: "channel", level: "nothing", actorKind: "human" })
  expect(accepted).toMatchObject({ setting: { level: "nothing" }, readStateRevision: 1 })
  expect(sqlite.prepare("SELECT revision FROM community_read_state_revision WHERE user_id='viewer'").get()).toMatchObject({ revision: 1 })
})
