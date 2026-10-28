import { afterEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { communityWriteDb } from "./helpers/community-write-db"
import * as queries from "../src/db/queries/automation"
import { AutomationAccessCodeCreateSchema, AutomationAccessCodeUpdateSchema, automationExpiresAt } from "../src/automation"

const databases: ReturnType<typeof communityWriteDb>[] = []
function fixture() {
  const value = communityWriteDb()
  value.sqlite.exec(readFileSync(new URL("../../web/migrations/0110_automation_access_code.sql", import.meta.url), "utf8"))
  databases.push(value)
  return value
}
afterEach(() => { for (const value of databases.splice(0)) value.sqlite.close() })
const input = () => AutomationAccessCodeCreateSchema.parse({ name: "Work", expiresIn: "24h", permissions: [{ permission: "bot.create", limit: 64, period: "hour" }, { permission: "server.create", limit: 100, period: "day" }] })

describe("Automation access codes", () => {
  it("enforces fixed expiry choices, integer rates, caps and unique granted permissions", () => {
    for (const data of [ { ...input(), expiresIn: "2h" }, { ...input(), permissions: [] }, { ...input(), permissions: [input().permissions[0], input().permissions[0]] }, ...[0, 1.5, 65].map((limit) => ({ ...input(), permissions: [{ permission: "bot.create", limit, period: "hour" }] })), { ...input(), permissions: [{ permission: "server.create", limit: 1537, period: "day" }] } ]) {
      expect(AutomationAccessCodeCreateSchema.safeParse(data).success).toBe(false)
    }
    expect(AutomationAccessCodeUpdateSchema.safeParse({}).success).toBe(false)
    expect(automationExpiresAt("forever")).toBeNull()
    expect(automationExpiresAt("7d", 0)).toBe("1970-01-08T00:00:00.000Z")
  })

  it("persists a hash and independent policies, while omitting private fields from management results", async () => {
    const { db, sqlite, batchSizes } = fixture()
    const code = await queries.createAccessCode(db, "author", input(), "digest", "aac_prefix")
    expect(await queries.listAccessCodes(db, "peer")).toEqual([])
    expect(await queries.getAccessCode(db, "peer", code.id)).toBeNull()
    const list = await queries.listAccessCodes(db, "author")
    expect(list).toEqual([code])
    expect(JSON.stringify(list)).not.toContain("digest")
    expect(list[0]).not.toHaveProperty("ownerId")
    expect(batchSizes).toEqual([[7, 8]])
    expect(sqlite.prepare("SELECT secret_hash FROM automation_access_code").get()).toEqual({ secret_hash: "digest" })
    expect(await queries.authenticateAccessCode(db, "digest", "server.create")).toMatchObject({ ownerId: "author", limit: 100, period: "day" })
    expect(await queries.authenticateAccessCode(db, "wrong", "bot.create")).toBeNull()
  })

  it("scopes edits and deletion, preserves expiry on policy edits and revokes removed policies", async () => {
    const { db, sqlite } = fixture()
    const code = await queries.createAccessCode(db, "author", input(), "digest", "prefix")
    expect(await queries.updateAccessCode(db, "peer", code.id, { name: "Stolen" })).toBeNull()
    expect(await queries.deleteAccessCode(db, "peer", code.id)).toBe(false)
    const edited = await queries.updateAccessCode(db, "author", code.id, { permissions: [{ permission: "server.create", limit: 1, period: "day" }] })
    expect(edited?.expiresAt).toBe(code.expiresAt)
    expect(await queries.authenticateAccessCode(db, "digest", "bot.create")).toBeNull()
    expect(await queries.authenticateAccessCode(db, "digest", "server.create")).toMatchObject({ limit: 1 })
    expect((await queries.updateAccessCode(db, "author", code.id, { expiresIn: "forever" }))?.expiresAt).toBeNull()
    expect(await queries.deleteAccessCode(db, "author", code.id)).toBe(true)
    expect(await queries.authenticateAccessCode(db, "digest", "server.create")).toBeNull()
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM automation_access_permission").get()).toEqual({ count: 0 })
  })

  it("rejects expiry at the exact boundary, soft-deleted owners and bot owners", async () => {
    const { db, sqlite } = fixture()
    const code = await queries.createAccessCode(db, "author", input(), "digest", "prefix")
    expect(await queries.authenticateAccessCode(db, "digest", "bot.create", code.expiresAt!)).toBeNull()
    sqlite.prepare("UPDATE user SET deletedAt = 'deleted' WHERE id = 'author'").run()
    expect(await queries.authenticateAccessCode(db, "digest", "bot.create")).toBeNull()
    sqlite.prepare("UPDATE user SET deletedAt = NULL, isBot = 1 WHERE id = 'author'").run()
    expect(await queries.authenticateAccessCode(db, "digest", "bot.create")).toBeNull()
  })

  it("scopes minimal read projections and friend resolution to the owner", async () => {
    const { db, sqlite } = fixture()
    sqlite.exec(`
      ALTER TABLE user ADD COLUMN name TEXT NOT NULL DEFAULT '';
      ALTER TABLE user ADD COLUMN discriminator TEXT NOT NULL DEFAULT '0001';
      UPDATE user SET name = id;
      INSERT INTO user (id,name) VALUES ('outsider','outside'), ('deleted','deleted');
      INSERT INTO user (id,name,isBot,ownerUserId) VALUES ('ownbot','Helper',1,'author');
      UPDATE user SET deletedAt='deleted' WHERE id='deleted';
      INSERT INTO community_friendship (id,requester_id,addressee_id,status) VALUES
        ('accepted','author','peer','accepted'), ('pending','author','outsider','pending'), ('deleted','author','deleted','accepted');
      CREATE TABLE community_machine (id TEXT PRIMARY KEY,user_id TEXT,display_name TEXT,hostname TEXT);
      INSERT INTO community_machine VALUES ('mac1','author','My Mac','hidden-host'),('other','peer','Other','secret-host');
      CREATE TABLE community_server (id TEXT PRIMARY KEY,name TEXT,discriminator TEXT,owner_id TEXT);
      INSERT INTO community_server VALUES ('s1','demo','0001','author'),('s2','private','0002','peer');
      INSERT INTO community_server_member VALUES ('member1','s1','author'),('member2','s2','peer');
    `)
    expect(await queries.listMachines(db, "author")).toEqual([{ id: "mac1", name: "My Mac" }])
    expect(await queries.listFriends(db, "author")).toEqual([{ name: "Helper", discriminator: "0001" }, { name: "peer", discriminator: "0001" }])
    expect(await queries.getFriendByHandle(db, "author", "outside#0001")).toBeNull()
    expect(await queries.getFriendByHandle(db, "author", "peer#0001")).toMatchObject({ id: "peer" })
    expect(await queries.getFriendByHandle(db, "author", "Helper#0001")).toMatchObject({ id: "ownbot" })
    expect(await queries.listServers(db, "author")).toEqual([{ name: "demo", discriminator: "0001" }])
  })
})
