import { beforeEach, afterEach, describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import type { Database } from "../../src/db"
import { submitCreationRequest, decideCreationRequest, getCreationRequest, hydrateCreationRequestsForDmMessages } from "../../src/db/queries/community/bot-creation"

let sqlite: Sqlite.Database
let db: Database
const proposal = (name: string) => ({ name, machineId: "m1", backendId: "codex", model: "custom/model", reason: "Independent review" })
const count = () => (sqlite.prepare('SELECT count(*) AS n FROM user WHERE isBot=1').get() as { n: number }).n
beforeEach(() => {
  sqlite = new Sqlite(":memory:")
  sqlite.pragma("foreign_keys = ON")
  const root = new URL("../../../web/migrations/", import.meta.url)
  for (const file of readdirSync(root).filter((file) => file.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, root), "utf8"))
  const orm = drizzle(sqlite)
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
    await submitCreationRequest(db, "owner", "requester", { requestId: "r1", bots: [proposal("A"), proposal("B")] })
    const [a, b] = await Promise.all([decideCreationRequest(db, "owner", "r1", "approve"), decideCreationRequest(db, "owner", "r1", "approve")])
    expect(a.row.status).toBe("approved")
    expect(b.row.bots).toEqual(a.row.bots)
    expect(count()).toBe(3)
    expect(sqlite.prepare("SELECT model_name FROM community_bot_binding WHERE user_id != 'requester'").all()).toEqual([{ model_name: "custom/model" }, { model_name: "custom/model" }])
    expect((await decideCreationRequest(db, "owner", "r1", "decline")).row.status).toBe("approved")
    expect(count()).toBe(3)
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
