import { afterEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { getTableName } from "drizzle-orm"
import { getTableConfig } from "drizzle-orm/sqlite-core"
import { communityWriteDb } from "./helpers/community-write-db"
import * as queries from "../src/db/queries/automation"
import { automationAccessCode, automationAccessPermission } from "../src/db/automation-schema"
import { AutomationAccessCodeCreateSchema, AutomationAccessCodeUpdateSchema, automationExpiresAt, AutomationPermissionSchema, AutomationMessageSendSchema } from "../src/automation"

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
    const code = await queries.createAccessCode(db, "author", input(), "digest")
    expect(await queries.listAccessCodes(db, "peer")).toEqual([])
    expect(await queries.getAccessCode(db, "peer", code.id)).toBeNull()
    const list = await queries.listAccessCodes(db, "author")
    expect(list).toEqual([code])
    expect(JSON.stringify(list)).not.toContain("digest")
    expect(list[0]).not.toHaveProperty("ownerId")
    expect(list[0]).not.toHaveProperty("prefix")
    expect(sqlite.prepare("PRAGMA table_info(automation_access_code)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "prefix" })]))
    expect(batchSizes).toEqual([[6, 8]])
    expect(sqlite.prepare("SELECT secret_hash FROM automation_access_code").get()).toEqual({ secret_hash: "digest" })
    expect(await queries.authenticateAccessCode(db, "digest", "server.create")).toMatchObject({ ownerId: "author", limit: 100, period: "day" })
    expect(await queries.authenticateAccessCode(db, "wrong", "bot.create")).toBeNull()
  })

  it("scopes edits and deletion, preserves expiry on policy edits and revokes removed policies", async () => {
    const { db, sqlite } = fixture()
    const code = await queries.createAccessCode(db, "author", input(), "digest")
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

  it.each([false, true])("renames an owned code while replacing policies: %s", async (replacePolicies) => {
    const { db, sqlite } = fixture()
    const code = await queries.createAccessCode(db, "author", input(), "digest")
    const peerCode = await queries.createAccessCode(db, "peer", input(), "peer-digest")
    const permissions = replacePolicies ? [{ permission: "server.invite" as const, limit: 2, period: "day" as const }] : code.permissions
    const edited = await queries.updateAccessCode(db, "author", code.id, {
      name: "Renamed",
      ...(replacePolicies ? { permissions } : {}),
    })

    expect(edited).toEqual({ ...code, name: "Renamed", permissions })
    expect(await queries.getAccessCode(db, "peer", peerCode.id)).toEqual(peerCode)
    expect(sqlite.prepare("SELECT owner_id, secret_hash FROM automation_access_code WHERE id = ?").get(code.id))
      .toEqual({ owner_id: "author", secret_hash: "digest" })
    expect(await queries.authenticateAccessCode(db, "digest", "bot.create"))
      .toEqual(replacePolicies ? null : expect.objectContaining({ ownerId: "author", limit: 64 }))
    if (replacePolicies) {
      expect(await queries.authenticateAccessCode(db, "digest", "server.invite"))
        .toMatchObject({ ownerId: "author", limit: 2, period: "day" })
    }
  })

  it("lists a code with missing policies without granting access, and leaves an empty query update unchanged", async () => {
    const { db, sqlite, batchSizes } = fixture()
    const code = await queries.createAccessCode(db, "author", input(), "digest")
    sqlite.prepare("DELETE FROM automation_access_permission WHERE code_id = ?").run(code.id)
    const withoutPolicies = { ...code, permissions: [] }

    expect(await queries.listAccessCodes(db, "author")).toEqual([withoutPolicies])
    expect(await queries.authenticateAccessCode(db, "digest", "bot.create")).toBeNull()
    expect(await queries.updateAccessCode(db, "author", code.id, {})).toEqual(withoutPolicies)
    expect(await queries.listAccessCodes(db, "author")).toEqual([withoutPolicies])
    expect(batchSizes).toHaveLength(1)
  })

  it("keeps declared owner and policy keys aligned with the migration and cascades only the deleted owner's codes", async () => {
    const { db, sqlite } = fixture()
    const codeConfig = getTableConfig(automationAccessCode)
    const policyConfig = getTableConfig(automationAccessPermission)
    for (const config of [codeConfig, policyConfig]) {
      const declared = config.foreignKeys.map((key) => {
        const reference = key.reference()
        return { from: reference.columns[0].name, table: getTableName(reference.foreignTable),
          to: reference.foreignColumns[0].name, on_delete: key.onDelete?.toUpperCase() }
      })
      const migrated = (sqlite.pragma(`foreign_key_list(${config.name})`) as Array<{
        from: string; table: string; to: string; on_delete: string;
      }>).map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete }))
      expect(migrated).toEqual(declared)
    }
    expect(codeConfig.indexes.map(({ config }) => ({ name: config.name, columns: config.columns })))
      .toEqual([{ name: "idx_automation_code_owner", columns: [automationAccessCode.ownerId] }])
    expect(sqlite.pragma("index_info(idx_automation_code_owner)"))
      .toEqual([expect.objectContaining({ name: "owner_id" })])
    expect(policyConfig.primaryKeys[0].columns.map((column) => column.name)).toEqual(["code_id", "permission"])
    expect((sqlite.pragma("table_info(automation_access_permission)") as Array<{ name: string; pk: number }>)
      .filter(({ pk }) => pk > 0).map(({ name }) => name)).toEqual(["code_id", "permission"])

    const authorCode = await queries.createAccessCode(db, "author", input(), "author-digest")
    const peerCode = await queries.createAccessCode(db, "peer", input(), "peer-digest")
    sqlite.prepare("DELETE FROM user WHERE id = ?").run("author")
    expect(await queries.getAccessCode(db, "author", authorCode.id)).toBeNull()
    expect(sqlite.prepare("SELECT code_id FROM automation_access_permission WHERE code_id = ?").all(authorCode.id)).toEqual([])
    expect(await queries.getAccessCode(db, "peer", peerCode.id)).toEqual(peerCode)
    expect(sqlite.pragma("foreign_key_check")).toEqual([])
  })

  it("rejects expiry at the exact boundary, soft-deleted owners and bot owners", async () => {
    const { db, sqlite } = fixture()
    const code = await queries.createAccessCode(db, "author", input(), "digest")
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
      INSERT INTO user (id,name,isBot,ownerUserId) VALUES ('ownbot','Helper',1,'author'), ('otherbot','Other bot',1,'peer'), ('unrelatedbot','Unrelated bot',1,'peer');
      UPDATE user SET deletedAt='deleted' WHERE id='deleted';
      INSERT INTO community_friendship (id,requester_id,addressee_id,status) VALUES
        ('accepted','author','peer','accepted'), ('otherbot','otherbot','author','accepted'), ('pending','author','outsider','pending'), ('deleted','author','deleted','accepted');
      CREATE TABLE community_machine (id TEXT PRIMARY KEY,user_id TEXT,display_name TEXT,hostname TEXT,status TEXT,available_runtimes TEXT NOT NULL DEFAULT '[]');
      INSERT INTO community_machine (id,user_id,display_name,hostname,status) VALUES ('mac1','author','My Mac','hidden-host','online'),('mac0','author','Stopped Mac','hidden-host','offline'),('other','peer','Other','secret-host','online');
    `)
    sqlite.prepare("UPDATE community_machine SET available_runtimes = ? WHERE id = ?").run(JSON.stringify(["codex"]), "mac1")
    expect(await queries.listMachines(db, "author")).toEqual([{ id: "mac0", name: "Stopped Mac", status: "offline", availableRuntimes: [] }, { id: "mac1", name: "My Mac", status: "online", availableRuntimes: ["codex"] }])
    expect(await queries.listFriends(db, "author")).toEqual([
      { name: "Helper", discriminator: "0001", isBot: true, ownerUserId: "author" },
      { name: "Other bot", discriminator: "0001", isBot: true, ownerUserId: "peer" },
      { name: "peer", discriminator: "0001", isBot: false, ownerUserId: null },
    ])
    expect(await queries.getFriendByHandle(db, "author", "outside#0001")).toBeNull()
    for (const handle of ["", "peer", "peer#123", "peer#abcd", " #0001"]) {
      expect(await queries.getFriendByHandle(db, "author", handle)).toBeNull()
    }
    expect(await queries.getFriendByHandle(db, "author", "peer#0001")).toMatchObject({ id: "peer" })
    expect(await queries.getFriendByHandle(db, "author", "Helper#0001")).toMatchObject({ id: "ownbot" })
  })
})

it("supports seven independent grants and scopes bot identity resolution in SQL", async () => {
  const all = AutomationAccessCodeCreateSchema.parse({ name: "all", permissions: AutomationPermissionSchema.options.map((permission) => ({ permission, limit: 1, period: "hour" })) })
  expect(all.permissions).toHaveLength(7)
  const { db, sqlite } = fixture()
  const code = await queries.createAccessCode(db, "author", all, "send-digest")
  expect(await queries.authenticateAccessCode(db, "send-digest", "message.send")).toMatchObject({ ownerId: "author", permission: "message.send" })
  expect(code.permissions).toHaveLength(7)
  sqlite.exec(`ALTER TABLE user ADD COLUMN name TEXT NOT NULL DEFAULT ''; ALTER TABLE user ADD COLUMN discriminator TEXT NOT NULL DEFAULT '0001';
    INSERT INTO user (id,name,isBot,ownerUserId) VALUES ('ownbot','Helper',1,'author'), ('otherbot','Other',1,'peer'), ('deletedbot','Deleted',1,'author');
    UPDATE user SET deletedAt='deleted' WHERE id='deletedbot'; UPDATE user SET name=id WHERE id IN ('author','peer');`)
  expect(await queries.getOwnedBotByHandle(db, "author", "Helper#0001")).toEqual({ id: "ownbot" })
  for (const handle of ["Other#0001", "Deleted#0001", "author#0001", "peer#0001", "Helper", "@Helper#0001"]) {
    expect(await queries.getOwnedBotByHandle(db, "author", handle)).toBeNull()
  }
  expect(await queries.getOwnedBotByHandle(db, "peer", "Helper#0001")).toBeNull()
})

it("validates file-send requests without accepting extra authority fields", () => {
  const body = { target: "/.dm/Alice#0001", as: "me", content: "hello\n", nonce: "n" }
  expect(AutomationMessageSendSchema.parse(body)).toEqual(body)
  expect(AutomationMessageSendSchema.parse({ ...body, as: "@Helper#0001" }).as).toBe("@Helper#0001")
  for (const change of [{ as: "Helper#0001" }, { as: "@Helper" }, { content: " " }, { target: "id" }, { ownerId: "peer" }, { nonce: "" }]) {
    expect(AutomationMessageSendSchema.safeParse({ ...body, ...change }).success).toBe(false)
  }
})
