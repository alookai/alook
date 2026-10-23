import { beforeEach, afterEach, describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { getTableName } from "drizzle-orm"
import { getTableConfig } from "drizzle-orm/sqlite-core"
import { communityBotCreationRequest } from "../../src/db/bot-creation-schema"
import type { Database } from "../../src/db"
import { submitCreationRequest, decideCreationRequest, getCreationRequest, hydrateCreationRequestsForDmMessages } from "../../src/db/queries/community/bot-creation"
import { ensureNewSiblingBotFriendships } from "../../src/db/queries/community/friendship"

let sqlite: Sqlite.Database
let db: Database
let queryLog: { sql: string; params: unknown[] }[]
const proposal = (name: string) => ({ name, machineId: "m1", backendId: "codex", model: "custom/model", reason: "Independent review" })
const count = () => (sqlite.prepare('SELECT count(*) AS n FROM user WHERE isBot=1').get() as { n: number }).n
beforeEach(() => {
  sqlite = new Sqlite(":memory:")
  sqlite.pragma("foreign_keys = ON")
  const root = new URL("../../../web/migrations/", import.meta.url)
  for (const file of readdirSync(root).filter((file) => file.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, root), "utf8"))
  queryLog = []
  const orm = drizzle(sqlite, { logger: { logQuery(sql, params) { queryLog.push({ sql, params }) } } })
  db = orm as unknown as Database
  ;(db as any).batch = async (statements: any[]) => sqlite.transaction(() => statements.map((statement) => sqlite.prepare(statement.toSQL().sql).reader ? statement.all() : statement.run()))()
  sqlite.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isBot,ownerUserId,discriminator) VALUES (?,?,?,?,?,?,?,?,?)').run("owner", "Owner", "owner@test.local", 1, "now", "now", 0, null, "0001")
  sqlite.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isBot,ownerUserId,discriminator) VALUES (?,?,?,?,?,?,?,?,?)').run("requester", "Requester", "requester@test.local", 1, "now", "now", 1, "owner", "0002")
  sqlite.prepare('INSERT INTO community_machine(id,user_id,display_name,hostname,platform,arch,available_runtimes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run("m1", "owner", "Work Mac", "host", "darwin", "arm64", JSON.stringify([{ id: "codex", status: "healthy", reasoning: { updateMode: "live_next_turn", models: [{ id: "listed", supportedReasoningEfforts: [{ value: "high" }] }] } }]), "online", "now", "now")
  sqlite.prepare('INSERT INTO community_bot_binding(user_id,machine_id,runtime,created_at) VALUES (?,?,?,?)').run("requester", "m1", "codex", "now")
  sqlite.exec("UPDATE product_plan_entitlement SET value_json='10' WHERE entitlement_key='bots.max'")
})
afterEach(() => sqlite.close())

describe("bot creation requests on real migrated SQLite", () => {
  it("matches migrated foreign keys and lookup indexes, and enforces card identity and valid state", async () => {
    const config = getTableConfig(communityBotCreationRequest)
    const declared = config.foreignKeys.map((key) => {
      const reference = key.reference()
      return { from: reference.columns[0]!.name, table: getTableName(reference.foreignTable), to: reference.foreignColumns[0]!.name, on_delete: key.onDelete!.toUpperCase() }
    }).sort((a, b) => a.from.localeCompare(b.from))
    const migrated = (sqlite.pragma("foreign_key_list(community_bot_creation_request)") as typeof declared).map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete })).sort((a, b) => a.from.localeCompare(b.from))
    expect(declared).toHaveLength(4)
    expect(migrated).toEqual(declared)
    expect(config.indexes.map((index) => index.config.name).sort()).toEqual(["idx_bot_creation_owner", "idx_bot_creation_requester"])
    for (const index of config.indexes) {
      const columns = index.config.columns.map((column) => "name" in column ? column.name : undefined)
      expect(sqlite.pragma(`index_info(${index.config.name})`)).toEqual(columns.map((name, seqno) => expect.objectContaining({ name, seqno })))
    }
    const { row } = await submitCreationRequest(db, "owner", "requester", { requestId: "schema", bots: [proposal("A")] })
    expect(() => sqlite.prepare("UPDATE community_bot_creation_request SET status='unknown' WHERE id=?").run(row.id)).toThrow(/CHECK/)
    expect(() => sqlite.prepare("UPDATE community_bot_creation_request SET bots='invalid json' WHERE id=?").run(row.id)).toThrow(/CHECK/)
    expect(() => sqlite.prepare("UPDATE community_bot_creation_request SET owner_id='missing' WHERE id=?").run(row.id)).toThrow(/FOREIGN KEY/)
    expect(() => sqlite.prepare("INSERT INTO community_bot_creation_request SELECT 'duplicate',requester_id,owner_id,channel_id,message_id,status,bots,decision_nonce,created_at,resolved_at FROM community_bot_creation_request WHERE id=?").run(row.id)).toThrow(/UNIQUE/)
    sqlite.prepare("DELETE FROM community_message WHERE id=?").run(row.messageId)
    expect(await getCreationRequest(db, row.id, { requesterId: "requester" })).toBeNull()
    expect(sqlite.pragma("foreign_key_check")).toEqual([])
  })
  it("returns the committed winner for concurrent submissions without duplicating the card or request", async () => {
    const input = { requestId: "race", bots: [proposal("A")] }
    const results = await Promise.all([submitCreationRequest(db, "owner", "requester", input), submitCreationRequest(db, "owner", "requester", input)])
    expect(results.map((result) => result.isNew).sort()).toEqual([false, true])
    expect(results[0]!.row).toEqual(results[1]!.row)
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_bot_creation_request").get()).toEqual({ n: 1 })
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_message").get()).toEqual({ n: 1 })
    expect(count()).toBe(1)
  })
  it("propagates a failed submission with no winner and rolls back its card and request", async () => {
    sqlite.exec("CREATE TRIGGER reject_request BEFORE INSERT ON community_bot_creation_request BEGIN SELECT RAISE(ABORT, 'request insert failed'); END")
    await expect(submitCreationRequest(db, "owner", "requester", { requestId: "failed", bots: [proposal("A")] })).rejects.toThrow("request insert failed")
    expect(await getCreationRequest(db, "failed", { requesterId: "requester" })).toBeNull()
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_message").get()).toEqual({ n: 0 })
    expect(count()).toBe(1)
  })
  it("connects twenty new bots to twenty existing siblings within D1 query and parameter limits", async () => {
    sqlite.exec("UPDATE product_plan_entitlement SET value_json='40' WHERE entitlement_key='bots.max'")
    for (let index = 1; index < 20; index++) {
      const id = `existing-${index}`
      sqlite.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isBot,ownerUserId,discriminator) VALUES (?,?,?,?,?,?,?,?,?)').run(id, id, `${id}@test.local`, 1, "now", "now", 1, "owner", "0001")
      sqlite.prepare('INSERT INTO community_bot_binding(user_id,machine_id,runtime,created_at) VALUES (?,?,?,?)').run(id, "m1", "codex", "now")
    }
    await submitCreationRequest(db, "owner", "requester", { requestId: "max", bots: Array.from({ length: 20 }, (_, index) => proposal(`New ${index}`)) })
    const result = await decideCreationRequest(db, "owner", "max", "approve")
    const created = result.row.bots.map((item) => item.createdBot!.id)
    expect(count()).toBe(40)
    queryLog = []
    await ensureNewSiblingBotFriendships(db, "owner", created)
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_friendship WHERE status='accepted'").get()).toEqual({ n: 590 })
    expect(queryLog.length).toBeLessThanOrEqual(62)
    expect(queryLog.every((query) => query.params.length <= 100)).toBe(true)
    console.info(JSON.stringify({ case: "siblings-20-existing-20-new", sqlStatements: queryLog.length, maxBoundParameters: Math.max(...queryLog.map((query) => query.params.length)) }))
    queryLog = []
    await Promise.all([ensureNewSiblingBotFriendships(db, "owner", created), ensureNewSiblingBotFriendships(db, "owner", created)])
    expect(sqlite.prepare('SELECT count(*) AS n FROM community_friendship').get()).toEqual({ n: 590 })
    expect(queryLog.length).toBeLessThanOrEqual(4)
  })
  it("preserves blocked and pending pairs, permits terminal re-friending and excludes foreign or deleted bots", async () => {
    await submitCreationRequest(db, "owner", "requester", { requestId: "pairs", bots: [proposal("A"), proposal("B")] })
    const result = await decideCreationRequest(db, "owner", "pairs", "approve")
    const [a, b] = result.row.bots.map((item) => item.createdBot!.id)
    sqlite.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isBot,ownerUserId,discriminator) VALUES (?,?,?,?,?,?,?,?,?)').run("other-owner", "Other owner", "other-owner@test.local", 1, "now", "now", 0, null, "0001")
    sqlite.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isBot,ownerUserId,discriminator,deletedAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run("foreign", "Foreign", "foreign@test.local", 1, "now", "now", 1, "other-owner", "0001", null)
    sqlite.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isBot,ownerUserId,discriminator,deletedAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run("deleted", "Deleted", "deleted@test.local", 1, "now", "now", 1, "owner", "0001", "now")
    for (const id of ["foreign", "deleted"]) sqlite.prepare('INSERT INTO community_bot_binding(user_id,machine_id,runtime,created_at) VALUES (?,?,?,?)').run(id, "m1", "codex", "now")
    const insert = sqlite.prepare('INSERT INTO community_friendship(id,requester_id,addressee_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    insert.run("blocked", a, "requester", "blocked", "now", "now")
    insert.run("pending", "requester", b, "pending", "now", "now")
    insert.run("denied", b, a, "denied", "now", "now")
    await Promise.all([ensureNewSiblingBotFriendships(db, "owner", [a!, b!, "foreign", "deleted"]), ensureNewSiblingBotFriendships(db, "owner", [a!, b!])])
    expect(sqlite.prepare('SELECT status FROM community_friendship WHERE id=?').get("blocked")).toEqual({ status: "blocked" })
    expect(sqlite.prepare('SELECT status FROM community_friendship WHERE id=?').get("pending")).toEqual({ status: "pending" })
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_friendship WHERE status='accepted'").get()).toEqual({ n: 1 })
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_friendship WHERE requester_id IN ('foreign','deleted') OR addressee_id IN ('foreign','deleted')").get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM community_friendship').get()).toEqual({ n: 4 })
  })
  it("stores one DM card for multiple proposals without creating or reserving bots", async () => {
    const result = await submitCreationRequest(db, "owner", "requester", { requestId: "r1", bots: [proposal("A"), proposal("B")] })
    expect(result.row.status).toBe("pending")
    expect(result.row.bots[0]).not.toHaveProperty("machineStatus")
    expect(count()).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM community_message').get()).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM community_bot_binding').get()).toEqual({ n: 1 })
    expect((await hydrateCreationRequestsForDmMessages(db, [result.row.messageId], "owner")).get(result.row.messageId)?.ownerUserId).toBe("owner")
    expect((await hydrateCreationRequestsForDmMessages(db, [result.row.messageId], "stranger")).size).toBe(0)
    await submitCreationRequest(db, "owner", "requester", { requestId: "r1", bots: [proposal("A"), proposal("B")] })
    expect(sqlite.prepare('SELECT count(*) AS n FROM community_message').get()).toEqual({ n: 1 })
  })
  it("approves all once, preserves custom models and keeps identity stable on repeated and concurrent decisions", async () => {
    const pending = await submitCreationRequest(db, "owner", "requester", { requestId: "r1", bots: [proposal("A"), proposal("B")] })
    const previewIds = pending.row.bots.map((item) => item.itemId)
    const [a, b] = await Promise.all([decideCreationRequest(db, "owner", "r1", "approve"), decideCreationRequest(db, "owner", "r1", "approve")])
    expect(a.row.status).toBe("approved")
    expect(b.row.bots).toEqual(a.row.bots)
    expect(a.row.bots.map((item) => item.createdBot!.id)).toEqual(previewIds)
    expect(new Set(previewIds).size).toBe(2)
    for (const id of previewIds) {
      expect(sqlite.prepare('SELECT id,ownerUserId,image,avatarVersion FROM user WHERE id=?').get(id)).toEqual({ id, ownerUserId: "owner", image: null, avatarVersion: 0 })
      expect(sqlite.prepare('SELECT machine_id FROM community_bot_binding WHERE user_id=?').get(id)).toEqual({ machine_id: "m1" })
    }
    expect(count()).toBe(3)
    expect(sqlite.prepare("SELECT model_name FROM community_bot_binding WHERE user_id != 'requester'").all()).toEqual([{ model_name: "custom/model" }, { model_name: "custom/model" }])
    expect((await decideCreationRequest(db, "owner", "r1", "decline")).row.status).toBe("approved")
    expect(count()).toBe(3)
  })
  it("does not rewrite historical approved identities when their proposal IDs differ", async () => {
    await submitCreationRequest(db, "owner", "requester", { requestId: "legacy", bots: [proposal("Legacy")] })
    const approved = await decideCreationRequest(db, "owner", "legacy", "approve")
    const legacyBots = approved.row.bots.map((item) => ({ ...item, itemId: "historical-preview-id" }))
    sqlite.prepare('UPDATE community_bot_creation_request SET bots=? WHERE id=?').run(JSON.stringify(legacyBots), "legacy")
    const before = sqlite.prepare('SELECT bots FROM community_bot_creation_request WHERE id=?').get("legacy")
    const result = await decideCreationRequest(db, "owner", "legacy", "approve")
    expect(result.changed).toBe(false)
    expect(result.row.bots).toEqual(legacyBots)
    expect(result.row.bots[0]!.createdBot!.id).toBe(approved.row.bots[0]!.createdBot!.id)
    expect(sqlite.prepare('SELECT bots FROM community_bot_creation_request WHERE id=?').get("legacy")).toEqual(before)
    expect(count()).toBe(2)
  })
  it("rolls back every bot and approval if a later item insert fails", async () => {
    await submitCreationRequest(db, "owner", "requester", { requestId: "r1", bots: [proposal("A"), proposal("B")] })
    sqlite.exec("CREATE TRIGGER reject_second BEFORE INSERT ON user WHEN NEW.name='B' BEGIN SELECT RAISE(ABORT, 'second item failed'); END")
    await expect(decideCreationRequest(db, "owner", "r1", "approve")).rejects.toThrow("second item failed")
    expect(count()).toBe(1)
    expect((await getCreationRequest(db, "r1", { ownerId: "owner" }))?.status).toBe("pending")
    expect(sqlite.prepare('SELECT count(*) AS n FROM community_bot_binding').get()).toEqual({ n: 1 })
  })
  it("rechecks capacity and leaves the entire request pending when insufficient", async () => {
    await submitCreationRequest(db, "owner", "requester", { requestId: "r1", bots: [proposal("A"), proposal("B")] })
    sqlite.exec("UPDATE product_plan_entitlement SET value_json='2' WHERE entitlement_key='bots.max'")
    await expect(decideCreationRequest(db, "owner", "r1", "approve")).rejects.toMatchObject({ code: "BOT_LIMIT_REACHED" })
    expect(count()).toBe(1)
    expect((await getCreationRequest(db, "r1", { ownerId: "owner" }))?.status).toBe("pending")
  })
  it("denies cross-owner reads/decisions, and decline never creates", async () => {
    await submitCreationRequest(db, "owner", "requester", { requestId: "r1", bots: [proposal("A")] })
    expect(await getCreationRequest(db, "r1", { ownerId: "stranger" })).toBe(null)
    await expect(decideCreationRequest(db, "stranger", "r1", "approve")).rejects.toMatchObject({ code: "REQUEST_NOT_FOUND" })
    await decideCreationRequest(db, "owner", "r1", "decline")
    expect((await decideCreationRequest(db, "owner", "r1", "approve")).row.status).toBe("declined")
    expect(count()).toBe(1)
  })
  it("rejects offline submission and rechecks machine connectivity before approval", async () => {
    sqlite.exec("UPDATE community_machine SET status='offline' WHERE id='m1'")
    await expect(submitCreationRequest(db, "owner", "requester", { requestId: "offline", bots: [proposal("A")] })).rejects.toMatchObject({ code: "MACHINE_OFFLINE", details: { machineId: "m1", itemIndex: 1 } })
    expect(sqlite.prepare('SELECT count(*) AS n FROM community_message').get()).toEqual({ n: 0 })
    sqlite.exec("UPDATE community_machine SET status='online' WHERE id='m1'")
    await submitCreationRequest(db, "owner", "requester", { requestId: "r1", bots: [proposal("A"), proposal("B")] })
    sqlite.exec("UPDATE community_machine SET status='offline' WHERE id='m1'")
    await expect(decideCreationRequest(db, "owner", "r1", "approve")).rejects.toMatchObject({ code: "MACHINE_OFFLINE" })
    expect(count()).toBe(1)
    expect((await getCreationRequest(db, "r1", { ownerId: "owner" }))?.status).toBe("pending")
  })
  it("rejects a stolen machine and per-model effort without any card", async () => {
    sqlite.exec("UPDATE community_machine SET user_id='requester' WHERE id='m1'")
    await expect(submitCreationRequest(db, "owner", "requester", { requestId: "r1", bots: [proposal("A")] })).rejects.toMatchObject({ code: "MACHINE_NOT_FOUND", details: { itemIndex: 1 } })
    sqlite.exec("UPDATE community_machine SET user_id='owner' WHERE id='m1'")
    await expect(submitCreationRequest(db, "owner", "requester", { requestId: "r1", bots: [{ ...proposal("A"), reasoningEffort: "high" }] })).rejects.toMatchObject({ code: "INVALID_REASONING_EFFORT" })
    expect(sqlite.prepare('SELECT count(*) AS n FROM community_message').get()).toEqual({ n: 0 })
  })
})
