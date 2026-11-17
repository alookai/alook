import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createRequire } from "node:module"
import { readFileSync, readdirSync } from "node:fs"
import type { SQLInputValue } from "node:sqlite"
import { NextRequest } from "next/server"
import { createDb, type Database } from "@alook/shared"

const state = vi.hoisted(() => ({ db: null as unknown, loseServerReceipt: false }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => state.db, getDb: () => state.db }))
vi.mock("./fanout", () => ({ fanOutToServerMembers: vi.fn(), fanOutToUsers: vi.fn(), broadcastToUserSafe: vi.fn(), fanOutToChannel: vi.fn() }))
vi.mock("./bot-push", () => ({ pushBotEventToMachine: vi.fn(async () => ({ sent: 0 })) }))
vi.mock("./message-dispatcher", () => ({ dispatchCommittedMessage: vi.fn(async () => {}) }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }))
import { runAutomationSetup } from "./automation-setup.server"
import { createBotForUser } from "./create-bot.server"

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite")
let sqlite: InstanceType<typeof DatabaseSync>
let db: Database
const input = () => ({ server: { name: "Growth Lab" }, bots: ["Mireille", "Thiago"].map(name => ({ name, machineId: "m1", backendId: "claude" })), firstTask: "Review the current draft and agree the next step." })
const request = (body: unknown = input()) => new NextRequest("https://test.local/api/community/automation/onboard-setup", { method: "POST", body: JSON.stringify(body) })
const context = () => ({ env: { DB: {} } as Env, userId: "owner", beforeAction: vi.fn(async (_permission: string): Promise<Response | null> => null) })
const activeBots = () => (sqlite.prepare('SELECT count(*) AS n FROM user WHERE isBot=1 AND deletedAt IS NULL').get() as { n: number }).n
const serverCount = () => (sqlite.prepare('SELECT count(*) AS n FROM community_server').get() as { n: number }).n
beforeEach(() => {
  state.loseServerReceipt = false
  sqlite = new DatabaseSync(":memory:")
  sqlite.exec("PRAGMA foreign_keys=ON")
  const migrations = new URL("../../../migrations/", import.meta.url)
  for (const file of readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"))
  const binding = {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const execute = (arrays: boolean) => {
        if (state.loseServerReceipt && sql.includes('from "user"') && sql.includes('"avatarVersion"') && serverCount() > 0) {
          state.loseServerReceipt = false
          throw new Error("lost database response after server commit")
        }
        const statement = sqlite.prepare(sql); statement.setReturnArrays(arrays); return statement.all(...values)
      }
      const prepared = {
        bind(...bindings: SQLInputValue[]) { values = bindings; return prepared },
        async raw() { return execute(true) },
        async all() { return { success: true, results: execute(false) } },
        async run() { return { success: true, meta: sqlite.prepare(sql).run(...values) } },
      }
      return prepared
    },
    async batch(statements: Array<{ all: () => Promise<unknown> }>) {
      sqlite.exec("BEGIN")
      try { const results = []; for (const statement of statements) results.push(await statement.all()); sqlite.exec("COMMIT"); return results }
      catch (failure) { sqlite.exec("ROLLBACK"); throw failure }
    },
  }
  db = createDb(binding as unknown as D1Database)
  state.db = db
  const add = sqlite.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isBot,discriminator) VALUES (?,?,?,?,?,?,?,?)')
  for (const id of ["owner", "peer"]) add.run(id, id, `${id}@test.local`, 1, "now", "now", 0, "0001")
  sqlite.prepare('INSERT INTO community_machine(id,user_id,display_name,hostname,platform,arch,available_runtimes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run("m1", "owner", "Work Mac", "host", "darwin", "arm64", JSON.stringify([{ id: "claude", status: "healthy" }]), "online", "now", "now")
  sqlite.exec("UPDATE product_plan_entitlement SET value_json='10' WHERE entitlement_key='bots.max'")
})
afterEach(() => sqlite?.close())

it("uses the real creation and message APIs to join the team before committing a human task without a bot reply", async () => {
  sqlite.exec("CREATE TRIGGER ensure_team_joined BEFORE INSERT ON community_message WHEN (SELECT count(*) FROM community_server_member WHERE server_id=(SELECT server_id FROM community_channel WHERE id=NEW.channel_id)) != 3 BEGIN SELECT RAISE(ABORT,'team not joined before task'); END")
  const ctx = context()
  const response = await runAutomationSetup(request(), ctx)
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
  const result = await response.json()
  expect(result).toMatchObject({ state: "sent", message: { seq: "#1" }, server: { url: expect.stringContaining("https://test.local/c/channels/") } })
  expect(activeBots()).toBe(2)
  expect(serverCount()).toBe(1)
  expect(sqlite.prepare("SELECT c.name,k.private FROM community_channel c JOIN community_category k ON k.id=c.category_id WHERE c.name='all' AND c.server_id=?").get(result.server.id)).toEqual({ name: "all", private: 0 })
  expect(sqlite.prepare('SELECT count(*) AS n FROM community_server_member WHERE server_id=?').get(result.server.id)).toEqual({ n: 3 })
  expect(sqlite.prepare('SELECT author_id,content FROM community_message').all()).toEqual([{ author_id: "owner", content: expect.stringContaining("Review the current draft") }])
  expect(ctx.beforeAction.mock.calls.map(([permission]) => permission)).toEqual(["bot.create", "bot.create", "server.create", "server.invite", "server.invite", "message.send"])
})

it("preserves the existing bot limit and cleans up a previously created bot when the next creation is denied", async () => {
  sqlite.exec("UPDATE product_plan_entitlement SET value_json='1' WHERE entitlement_key='bots.max'")
  const response = await runAutomationSetup(request(), context())
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: "BOT_LIMIT_REACHED", cleanup: "complete" })
  expect(activeBots()).toBe(0)
  expect(serverCount()).toBe(0)
})

it.each(["server.create", "server.invite", "message.send"])("cleans up all new resources when %s is denied", async permission => {
  const ctx = context()
  ctx.beforeAction.mockImplementation(async action => action === permission ? Response.json({ error: "limited" }, { status: 429, headers: { "Retry-After": "9" } }) : null)
  const response = await runAutomationSetup(request(), ctx)
  expect(response.status).toBe(429)
  expect(response.headers.get("Retry-After")).toBe("9")
  expect(await response.json()).toMatchObject({ cleanup: "complete" })
  expect(activeBots()).toBe(0)
  expect(serverCount()).toBe(0)
  expect(sqlite.prepare('SELECT count(*) AS n FROM community_message').get()).toEqual({ n: 0 })
})

it("preserves reused bots and reports actual remaining resources when cleanup fails", async () => {
  const created = await createBotForUser(request({ name: "Existing", machineId: "m1", runtime: "claude" }), { env: { DB: {} } as Env, userId: "owner" })
  const existing = (await created.json()).bot.id as string
  sqlite.exec("CREATE TRIGGER injected_cleanup_failure BEFORE DELETE ON community_server BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END")
  const ctx = context()
  ctx.beforeAction.mockImplementation(async action => action === "message.send" ? Response.json({ error: "limited" }, { status: 429 }) : null)
  const body = input()
  const response = await runAutomationSetup(request({ ...body, bots: [{ existingBotId: existing }, body.bots[0]] }), ctx)
  const result = await response.json()
  expect(response.status).toBe(429)
  expect(result).toMatchObject({ cleanup: "incomplete", remaining: { serverId: expect.any(String), botIds: [] } })
  expect(activeBots()).toBe(1)
  expect(sqlite.prepare('SELECT deletedAt FROM user WHERE id=?').get(existing)).toEqual({ deletedAt: null })
  expect(sqlite.prepare('SELECT id FROM community_server').all()).toEqual([{ id: result.remaining.serverId }])
})

it("rejects foreign bots and unavailable machines without leaving newly created resources", async () => {
  const foreign = await createBotForUser(request({ name: "Foreign", machineId: "m1", runtime: "claude" }), { env: { DB: {} } as Env, userId: "owner" })
  const botId = (await foreign.json()).bot.id as string
  sqlite.prepare('UPDATE user SET ownerUserId=? WHERE id=?').run("peer", botId)
  expect((await runAutomationSetup(request({ ...input(), bots: [{ existingBotId: botId }] }), context())).status).toBe(404)
  sqlite.exec("UPDATE community_machine SET status='offline' WHERE id='m1'")
  expect((await runAutomationSetup(request(), context())).status).toBe(409)
  expect(activeBots()).toBe(1)
  expect(serverCount()).toBe(0)
})


it("reports an unknown outcome instead of claiming full cleanup when a creation handler loses its post-commit receipt", async () => {
  state.loseServerReceipt = true
  const response = await runAutomationSetup(request(), context())
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: "SETUP_OUTCOME_UNKNOWN", cleanup: "unknown", error: expect.stringContaining("check whether the server and bots were created") })
  expect(serverCount()).toBe(1)
  expect(activeBots()).toBe(0)
})
