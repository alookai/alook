import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createRequire } from "node:module"
import { readFileSync, readdirSync } from "node:fs"
import type { SQLInputValue } from "node:sqlite"
import { NextRequest } from "next/server"
import { createDb, formatHandle, type Database } from "@alook/shared"

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
let botIds: string[]
let botHandles: string[]
const input = () => ({ server: { name: "Growth Lab" }, bots: botHandles, firstTask: "Review the current draft and agree the next step." })
const request = (body: unknown = input()) => new NextRequest("https://test.local/api/community/automation/onboard-setup", { method: "POST", body: JSON.stringify(body) })
const context = () => ({ env: { DB: {} } as Env, userId: "owner", beforeAction: vi.fn(async (_permission: string): Promise<Response | null> => null) })
const activeBots = () => (sqlite.prepare('SELECT count(*) AS n FROM user WHERE isBot=1 AND deletedAt IS NULL').get() as { n: number }).n
const serverCount = () => (sqlite.prepare('SELECT count(*) AS n FROM community_server').get() as { n: number }).n
beforeEach(async () => {
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
  botIds = []
  botHandles = []
  for (const name of ["Mireille", "Thiago"]) {
    const response = await createBotForUser(request({ name, machineId: "m1", runtime: "claude" }), { env: { DB: {} } as Env, userId: "owner" })
    expect(response.status).toBe(201)
    const bot = (await response.json()).bot
    botIds.push(bot.id)
    botHandles.push(formatHandle(bot.name, bot.discriminator))
  }
})
afterEach(() => sqlite?.close())

it("creates only the server and joins existing bots before committing the human task", async () => {
  sqlite.exec("CREATE TRIGGER ensure_team_joined BEFORE INSERT ON community_message WHEN (SELECT count(*) FROM community_server_member WHERE server_id=(SELECT server_id FROM community_channel WHERE id=NEW.channel_id)) != 3 BEGIN SELECT RAISE(ABORT,'team not joined before task'); END")
  const ctx = context()
  const response = await runAutomationSetup(request(), ctx)
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
  const result = await response.json()
  const server = sqlite.prepare('SELECT id,name,discriminator FROM community_server').get() as { id: string; name: string; discriminator: string }
  const handle = formatHandle(server.name, server.discriminator)
  expect(result).toEqual({ state: "sent", server: { handle, url: `https://test.local/c/channels/${server.id}`, channel: `/${handle}/all` }, bots: botHandles, message: { seq: "#1" } })
  expect(activeBots()).toBe(2)
  expect(serverCount()).toBe(1)
  expect(sqlite.prepare("SELECT c.name,k.private FROM community_channel c JOIN community_category k ON k.id=c.category_id WHERE c.name='all' AND c.server_id=?").get(server.id)).toEqual({ name: "all", private: 0 })
  expect(sqlite.prepare('SELECT count(*) AS n FROM community_server_member WHERE server_id=?').get(server.id)).toEqual({ n: 3 })
  const messages = sqlite.prepare('SELECT author_id,content FROM community_message').all()
  expect(messages).toEqual([{ author_id: "owner", content: expect.stringContaining("Review the current draft") }])
  expect(sqlite.prepare("SELECT user_id FROM community_mention WHERE kind='mention' ORDER BY user_id").all()).toEqual([...botIds].sort().map(user_id => ({ user_id })))
  expect(ctx.beforeAction.mock.calls.map(([permission]) => permission)).toEqual(["server.create", "server.invite", "server.invite", "message.send"])
})

it("uses already-owned bots even when bot creation is unavailable and their machine is offline", async () => {
  sqlite.exec("UPDATE product_plan_entitlement SET value_json='0' WHERE entitlement_key='bots.max'; UPDATE community_machine SET status='offline' WHERE id='m1'")
  const response = await runAutomationSetup(request(), context())
  expect(response.status).toBe(200)
  expect(activeBots()).toBe(2)
  expect(serverCount()).toBe(1)
})

it.each(["server.create", "server.invite", "message.send"])("cleans up only its new server when %s is denied", async permission => {
  const ctx = context()
  ctx.beforeAction.mockImplementation(async action => action === permission ? Response.json({ error: "limited" }, { status: 429, headers: { "Retry-After": "9" } }) : null)
  const response = await runAutomationSetup(request(), ctx)
  expect(response.status).toBe(429)
  expect(response.headers.get("Retry-After")).toBe("9")
  expect(await response.json()).toMatchObject({ cleanup: "complete" })
  expect(activeBots()).toBe(2)
  expect(serverCount()).toBe(0)
  expect(sqlite.prepare('SELECT count(*) AS n FROM community_message').get()).toEqual({ n: 0 })
  for (const id of botIds) expect(sqlite.prepare('SELECT deletedAt FROM user WHERE id=?').get(id)).toEqual({ deletedAt: null })
})

it("removes its partially joined server if a later invitation fails without deleting any bot", async () => {
  const ctx = context()
  let invites = 0
  ctx.beforeAction.mockImplementation(async action => action === "server.invite" && ++invites === 2 ? Response.json({ error: "limited" }, { status: 429 }) : null)
  const response = await runAutomationSetup(request(), ctx)
  expect(response.status).toBe(429)
  expect(await response.json()).toMatchObject({ cleanup: "complete" })
  expect(serverCount()).toBe(0)
  expect(activeBots()).toBe(2)
  expect(sqlite.prepare('SELECT count(*) AS n FROM community_server_member').get()).toEqual({ n: 0 })
})

it("reports the remaining server accurately if cleanup fails and preserves both selected bots", async () => {
  sqlite.exec("CREATE TRIGGER injected_cleanup_failure BEFORE DELETE ON community_server BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END")
  const ctx = context()
  ctx.beforeAction.mockImplementation(async action => action === "message.send" ? Response.json({ error: "limited" }, { status: 429 }) : null)
  const response = await runAutomationSetup(request(), ctx)
  const result = await response.json()
  expect(response.status).toBe(429)
  expect(result.cleanup).toBe("incomplete")
  const server = sqlite.prepare('SELECT name,discriminator FROM community_server').get() as { name: string; discriminator: string }
  expect(result.remaining).toEqual({ server: formatHandle(server.name, server.discriminator) })
  expect(activeBots()).toBe(2)
  expect(serverCount()).toBe(1)
})

it("rejects foreign, human and missing bot handles before creating a server", async () => {
  sqlite.prepare('UPDATE user SET ownerUserId=? WHERE id=?').run("peer", botIds[0]!)
  for (const handle of [botHandles[0]!, "owner#0001", "Missing#9999"]) {
    const ctx = context()
    expect((await runAutomationSetup(request({ ...input(), bots: [handle] }), ctx)).status).toBe(404)
    expect(ctx.beforeAction).not.toHaveBeenCalled()
  }
  expect(activeBots()).toBe(2)
  expect(serverCount()).toBe(0)
})

it("rejects empty, repeated and creation-shaped bot selections without changing resources", async () => {
  for (const bots of [[], [botHandles[0], botHandles[0]], [botHandles[0], botHandles[0]!.replace("#", " #")], [botIds[0]], [{ name: "New bot", machineId: "m1", backendId: "claude" }]]) {
    const ctx = context()
    expect((await runAutomationSetup(request({ ...input(), bots }), ctx)).status).toBe(400)
    expect(ctx.beforeAction).not.toHaveBeenCalled()
  }
  expect(activeBots()).toBe(2)
  expect(serverCount()).toBe(0)
})

it("reports an unknown server outcome after a lost post-commit receipt without modifying selected bots", async () => {
  state.loseServerReceipt = true
  const response = await runAutomationSetup(request(), context())
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: "SETUP_OUTCOME_UNKNOWN", cleanup: "unknown", error: expect.stringContaining("check the server and its bot membership") })
  expect(serverCount()).toBe(1)
  expect(activeBots()).toBe(2)
})
