import { beforeEach, describe, it, expect, vi } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3"
import Sqlite from "better-sqlite3"
import * as q from "../../src/db/queries/community/bot"
import { communityBotSyntheticEmail } from "../../src/constants"
import { CommunityBotCreateRequestSchema, CommunityBotPatchRequestSchema, CommunityServerOnboardRequestSchema } from "../../src/schemas"

const opaqueAllocation = vi.hoisted(() => ({ next: vi.fn(() => "0042") }))
vi.mock("../../src/lib/discriminator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/discriminator")>()
  return { ...actual, computeDiscriminator: opaqueAllocation.next }
})

beforeEach(() => {
  opaqueAllocation.next.mockReset().mockReturnValue("0042")
})

type NativeStatement = {
  toSQL(): { sql: string; params: unknown[] }
  all(): unknown
  run(): unknown
}

function createMigratedDatabase() {
  const sqlite = new Sqlite(":memory:")
  try {
    sqlite.pragma("foreign_keys = ON")
    const root = new URL("../../../web/migrations/", import.meta.url)
    for (const name of readdirSync(root).filter(name => name.endsWith(".sql")).sort()) {
      sqlite.exec(readFileSync(new URL(name, root), "utf8"))
    }
    const errors: unknown[] = []
    const orm = drizzleSqlite(sqlite)
    const batch = vi.fn(async (statements: NativeStatement[]) => {
      try {
        return sqlite.transaction(() => statements.map(statement => {
          const query = statement.toSQL()
          return sqlite.prepare(query.sql).reader ? statement.all() : statement.run()
        }))()
      } catch (error) {
        errors.push(error)
        throw error
      }
    })
    const db = Object.assign(orm, { batch }) as unknown as Parameters<typeof q.createBot>[0]
    sqlite.exec(`
      INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,isBot,ownerUserId,discriminator)
        VALUES ('owner_1','Owner','owner@example.test',1,'2026-01-01','2026-01-01',0,NULL,'9999');
      INSERT INTO community_machine
        (id,user_id,display_name,hostname,platform,arch,available_runtimes,status,created_at,updated_at)
        VALUES ('machine_1','owner_1','Work Mac','host','darwin','arm64','[{"id":"codex","status":"healthy"}]','online','2026-01-01','2026-01-01');
      UPDATE product_plan_entitlement SET value_json='10' WHERE entitlement_key='bots.max';
    `)
    return { sqlite, db, batch, errors }
  } catch (error) {
    sqlite.close()
    throw error
  }
}


describe("communityBotSyntheticEmail", () => {
  it("lowercases + uses bots.alook.local domain", () => {
    const email = communityBotSyntheticEmail("ABC123")
    expect(email).toBe("bot-abc123@bots.alook.local")
  })
  it("is injective on userId — different ids → different emails", () => {
    expect(communityBotSyntheticEmail("a")).not.toBe(communityBotSyntheticEmail("b"))
  })
})

describe("createBot", () => {
  it("writes a discriminator for the bot user row", async () => {
    const { sqlite, db, batch, errors } = createMigratedDatabase()
    try {
      const result = await q.createBot(db, {
        ownerId: "owner_1", name: "helper", description: "does things",
        machineId: "machine_1", runtime: "codex",
      })
      expect(result.discriminator).toBe("0042")
      expect(result.discriminator).toMatch(/^\d{4}$/)
      expect(sqlite.prepare("SELECT id,name,ownerUserId,discriminator,image,avatarVersion FROM user WHERE id=?").get(result.botId))
        .toEqual({ id: result.botId, name: "helper", ownerUserId: "owner_1", discriminator: "0042", image: null, avatarVersion: 0 })
      expect(sqlite.prepare("SELECT user_id,machine_id,runtime,instruction FROM community_bot_binding WHERE user_id=?").get(result.botId))
        .toEqual({ user_id: result.botId, machine_id: "machine_1", runtime: "codex", instruction: "does things" })
      expect(sqlite.prepare("SELECT user_id,about_me FROM community_user_profile WHERE user_id=?").get(result.botId))
        .toEqual({ user_id: result.botId, about_me: "does things" })
      expect(batch).toHaveBeenCalledOnce()
      expect(batch.mock.calls[0]![0]).toHaveLength(3)
      expect(errors).toEqual([])
      expect(sqlite.pragma("foreign_key_check")).toEqual([])
    } finally { sqlite.close() }
  })

  it("retries the whole batch after a real collision and returns the stored identity", async () => {
    const { sqlite, db, batch, errors } = createMigratedDatabase()
    try {
      sqlite.exec(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,isBot,ownerUserId,discriminator)
        VALUES ('collision','helper','collision@example.test',1,'2026-01-01','2026-01-01',0,NULL,'0042')`)
      opaqueAllocation.next.mockReturnValueOnce("0042").mockReturnValue("0099")
      const result = await q.createBot(db, {
        ownerId: "owner_1", name: "helper", description: "does things",
        machineId: "machine_1", runtime: "codex",
      })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" })
      expect(batch.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(batch.mock.calls.every(([statements]) => statements.length === 3)).toBe(true)
      expect(result.discriminator).toBe("0099")
      expect(sqlite.prepare("SELECT id,discriminator,ownerUserId FROM user WHERE isBot=1").all())
        .toEqual([{ id: result.botId, discriminator: "0099", ownerUserId: "owner_1" }])
      expect(sqlite.prepare("SELECT user_id,instruction FROM community_bot_binding").all())
        .toEqual([{ user_id: result.botId, instruction: "does things" }])
      expect(sqlite.prepare("SELECT user_id,about_me FROM community_user_profile WHERE user_id=?").all(result.botId))
        .toEqual([{ user_id: result.botId, about_me: "does things" }])
      expect(sqlite.prepare("SELECT id,name,discriminator FROM user WHERE id='collision'").get())
        .toEqual({ id: "collision", name: "helper", discriminator: "0042" })
      expect(sqlite.pragma("foreign_key_check")).toEqual([])
      const collision = errors[0] as Error & { code: string }
      console.info("native-bot-create-collision", { code: collision.code, message: collision.message, attempts: batch.mock.calls.length })
    } finally { sqlite.close() }
  })

  it("rethrows a non-unique-constraint db.batch failure without retrying", async () => {
    const otherErr = new Error("D1_ERROR: disk I/O error")
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => ({ __stmt: "profile" })) })),
      })),
      batch: vi.fn().mockRejectedValue(otherErr),
    }

    await expect(
      q.createBot(db as never, {
        ownerId: "owner_1",
        name: "helper",
        description: "does things",
        machineId: "machine_1",
        runtime: "codex",
      }),
    ).rejects.toBe(otherErr)
    expect(db.batch).toHaveBeenCalledOnce()
  })
})

describe("bot runtime-config read projections", () => {
  const storedBot = {
    id: "bot_1",
    name: "helper",
    discriminator: "1234",
    image: null,
    avatarVersion: null,
    ownerUserId: "owner_1",
    description: "does things",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    lastRefreshContextAt: null,
    machineId: "machine_1",
    runtime: "codex",
    modelName: "gpt-5",
    reasoningEffort: "high",
    runtimeConfigRevision: 7,
    isActive: true,
  }

  function makeOwnerListChain(rows: unknown[]) {
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.innerJoin = vi.fn(() => chain)
    chain.where = vi.fn(() => Promise.resolve(rows))
    return chain
  }

  function makeLimitedReadChain(rows: unknown[]) {
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.leftJoin = vi.fn(() => chain)
    chain.innerJoin = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve(rows))
    return chain
  }

  it("returns reasoning effort and revision when listing an owner's bots", async () => {
    await expect(q.listBotsForOwner(makeOwnerListChain([{ ...storedBot, machineStatus: "online" }]), "owner_1")).resolves.toEqual([
      { ...storedBot, presence: "online", tokenUsageTimeZone: null },
    ])
  })

  it("projects inactive bots offline even while their bound machine is online", async () => {
    await expect(q.listBotsForOwner(makeOwnerListChain([
      { ...storedBot, isActive: false, machineStatus: "online" },
    ]), "owner_1")).resolves.toEqual([
      { ...storedBot, isActive: false, presence: "offline", tokenUsageTimeZone: null },
    ])
  })

  it("returns reasoning effort and revision from the owner-scoped lookup", async () => {
    await expect(q.getBotOwnedBy(makeLimitedReadChain([storedBot]), "bot_1", "owner_1")).resolves.toEqual(
      { ...storedBot, avatarObjectKey: undefined },
    )
  })

  it("returns reasoning effort and revision in a ready wake context", async () => {
    await expect(q.getBotWakeContext(makeLimitedReadChain([{ ...storedBot, isBot: true, deletedAt: null }]), "bot_1"))
      .resolves.toEqual({
        state: "ready",
        botUserId: "bot_1",
        name: "helper",
        discriminator: "1234",
        machineId: "machine_1",
        runtime: "codex",
        modelName: "gpt-5",
        reasoningEffort: "high",
        runtimeConfigRevision: 7,
        ownerUserId: "owner_1",
      })
  })

  it("returns the owner binding state and stops wake resolution for an inactive bot", async () => {
    const inactive = { ...storedBot, isBot: true, deletedAt: null, isActive: false }

    await expect(q.getBotBindingWithOwner(makeLimitedReadChain([inactive]), "bot_1"))
      .resolves.toEqual({
        machineId: "machine_1",
        runtime: "codex",
        ownerUserId: "owner_1",
        name: "helper",
        discriminator: "1234",
        isActive: false,
      })
    await expect(q.getBotWakeContext(makeLimitedReadChain([inactive]), "bot_1"))
      .resolves.toEqual({ state: "bot_inactive" })
  })
})

describe("getBotBinding", () => {
  function makeSelectChain(rows: unknown[]) {
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve(rows))
    return chain
  }

  it("returns the full runtime binding when it exists", async () => {
    const chain = makeSelectChain([{ machineId: "machine_1", runtime: "codex", modelName: null, isActive: true }])
    const result = await q.getBotBinding(chain, "bot_1")
    expect(result).toEqual({
      machineId: "machine_1",
      runtime: "codex",
      modelName: null,
      reasoningEffort: null,
      runtimeConfigRevision: 0,
      isActive: true,
    })
  })

  it("surfaces a stored modelName", async () => {
    const chain = makeSelectChain([{ machineId: "machine_1", runtime: "claude", modelName: "claude-opus-4-6", isActive: false }])
    const result = await q.getBotBinding(chain, "bot_1")
    expect(result).toEqual({
      machineId: "machine_1",
      runtime: "claude",
      modelName: "claude-opus-4-6",
      reasoningEffort: null,
      runtimeConfigRevision: 0,
      isActive: false,
    })
  })

  it("returns null when no binding row matches", async () => {
    const chain = makeSelectChain([])
    const result = await q.getBotBinding(chain, "ghost_bot")
    expect(result).toBeNull()
  })
})

describe("getMachineForOwner", () => {
  function makeSelectChain(rows: unknown[]) {
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve(rows))
    return chain
  }

  it("returns null when the owner-scoped machine lookup has no row", async () => {
    await expect(q.getMachineForOwner(makeSelectChain([]), "machine_1", "owner_1")).resolves.toBeNull()
  })

  it("normalizes legacy strings and valid objects while dropping malformed entries", async () => {
    const db = makeSelectChain([{
      id: "machine_1",
      availableRuntimes: [
        "codex",
        "",
        { id: "claude", status: "unhealthy", lastError: "missing credentials" },
        { id: "bad runtime", status: "healthy" },
        null,
      ],
    }])

    await expect(q.getMachineForOwner(db, "machine_1", "owner_1")).resolves.toEqual({
      id: "machine_1",
      availableRuntimes: [
        { id: "codex", status: "healthy" },
        { id: "claude", status: "unhealthy", lastError: "missing credentials" },
      ],
    })
  })
})

describe("updateBotRuntimeConfig", () => {
  function createDatabase() {
    const sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        isBot INTEGER NOT NULL DEFAULT 0,
        ownerUserId TEXT,
        deletedAt TEXT
      );
      CREATE TABLE community_bot_binding (
        user_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        model_name TEXT,
        reasoning_effort TEXT,
        runtime_config_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO user (id, isBot, ownerUserId, deletedAt)
      VALUES ('bot_1', 1, 'owner_1', NULL);
      INSERT INTO community_bot_binding (
        user_id, machine_id, runtime, instruction, model_name,
        reasoning_effort, runtime_config_revision, created_at
      ) VALUES (
        'bot_1', 'machine_1', 'codex', '', 'gpt-old',
        'low', 4, '2026-08-29T00:00:00.000Z'
      );
    `)
    return { sqlite, db: drizzleSqlite(sqlite) }
  }

  it("atomically replaces the full tuple and increments one server revision", async () => {
    const { sqlite, db } = createDatabase()
    try {
      await expect(q.updateBotRuntimeConfig(db as never, "bot_1", "owner_1", {
        runtime: "codex",
        modelName: "gpt-new",
        reasoningEffort: "xhigh",
      })).resolves.toEqual({ runtimeConfigRevision: 5 })
      expect(sqlite.prepare(`
        SELECT runtime, model_name AS modelName,
               reasoning_effort AS reasoningEffort,
               runtime_config_revision AS runtimeConfigRevision
        FROM community_bot_binding WHERE user_id = 'bot_1'
      `).get()).toEqual({
        runtime: "codex",
        modelName: "gpt-new",
        reasoningEffort: "xhigh",
        runtimeConfigRevision: 5,
      })
    } finally {
      sqlite.close()
    }
  })

  it("persists a parameterized ACP model value byte-for-byte", async () => {
    const { sqlite, db } = createDatabase()
    const exactValue = "grok-4.6[effort=high,fast=true]"
    try {
      await expect(q.updateBotRuntimeConfig(db as never, "bot_1", "owner_1", {
        runtime: "cursor",
        modelName: exactValue,
        reasoningEffort: null,
      })).resolves.toEqual({ runtimeConfigRevision: 5 })
      expect(sqlite.prepare(`
        SELECT runtime, model_name AS modelName
        FROM community_bot_binding WHERE user_id = 'bot_1'
      `).get()).toEqual({ runtime: "cursor", modelName: exactValue })
    } finally {
      sqlite.close()
    }
  })

  it("does not change the tuple or revision for a different owner", async () => {
    const { sqlite, db } = createDatabase()
    try {
      await expect(q.updateBotRuntimeConfig(db as never, "bot_1", "owner_2", {
        runtime: "claude",
        modelName: "foreign-model",
        reasoningEffort: "max",
      })).resolves.toBeNull()
      expect(sqlite.prepare(`
        SELECT runtime, model_name AS modelName,
               reasoning_effort AS reasoningEffort,
               runtime_config_revision AS runtimeConfigRevision
        FROM community_bot_binding WHERE user_id = 'bot_1'
      `).get()).toEqual({
        runtime: "codex",
        modelName: "gpt-old",
        reasoningEffort: "low",
        runtimeConfigRevision: 4,
      })
    } finally {
      sqlite.close()
    }
  })
})

describe("listBotsForMachine", () => {
  it("allows local configuration of inactive bots only when explicitly requested, retaining machine/deletion guards", async () => {
    const sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (id TEXT, name TEXT, discriminator TEXT, isBot INTEGER, ownerUserId TEXT, deletedAt TEXT);
      CREATE TABLE community_bot_binding (user_id TEXT, machine_id TEXT, runtime TEXT, model_name TEXT, reasoning_effort TEXT, runtime_config_revision INTEGER, instruction TEXT, is_active INTEGER);
      INSERT INTO user VALUES ('owner', 'Owner', '0001', 0, NULL, NULL),
        ('active', 'Active', '0002', 1, 'owner', NULL), ('inactive', 'Inactive', '0003', 1, 'owner', NULL),
        ('foreign', 'Foreign', '0004', 1, 'owner', NULL), ('deleted', 'Deleted', '0005', 1, 'owner', 'deleted');
      INSERT INTO community_bot_binding VALUES ('active', 'machine', 'codex', NULL, NULL, 0, '', 1),
        ('inactive', 'machine', 'codex', NULL, NULL, 0, '', 0), ('foreign', 'other-machine', 'codex', NULL, NULL, 0, '', 0),
        ('deleted', 'machine', 'codex', NULL, NULL, 0, '', 0);
    `)
    const db = drizzleSqlite(sqlite) as unknown as Parameters<typeof q.listBotsForMachine>[0]
    try {
      expect((await q.listBotsForMachine(db, "machine")).map(bot => bot.id)).toEqual(["active"])
      expect((await q.listBotsForMachine(db, "machine", { includeInactive: true })).map(bot => bot.id)).toEqual(["active", "inactive"])
      sqlite.prepare("UPDATE user SET deletedAt = 'deleted' WHERE id = 'owner'").run()
      expect(await q.listBotsForMachine(db, "machine", { includeInactive: true })).toEqual([])
    } finally { sqlite.close() }
  })

  function makeJoinChain(rows: unknown[]) {
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.innerJoin = vi.fn(() => chain)
    chain.leftJoin = vi.fn(() => chain)
    // `where` is awaited directly (no `.limit` in listBotsForMachine).
    chain.where = vi.fn(() => Promise.resolve(rows))
    return chain
  }

  it("projects the owner's name/discriminator alongside the bot's own fields", async () => {
    const chain = makeJoinChain([
      {
        id: "bot_1",
        name: "helper",
        discriminator: "1234",
        description: "does things",
        ownerName: "gustavo",
        ownerDiscriminator: "5678",
        runtime: "claude",
        modelName: "claude-opus-4-6",
        reasoningEffort: null,
        runtimeConfigRevision: 0,
      },
    ])
    const result = await q.listBotsForMachine(chain, "machine_1")
    expect(result).toEqual([
      {
        id: "bot_1",
        name: "helper",
        discriminator: "1234",
        description: "does things",
        ownerName: "gustavo",
        ownerDiscriminator: "5678",
        runtime: "claude",
        modelName: "claude-opus-4-6",
        reasoningEffort: null,
        runtimeConfigRevision: 0,
      },
    ])
  })

  it("defaults modelName to null when the binding has none", async () => {
    const chain = makeJoinChain([
      {
        id: "bot_1",
        name: "helper",
        discriminator: "1234",
        description: "does things",
        ownerName: "gustavo",
        ownerDiscriminator: "5678",
        runtime: "claude",
        modelName: null,
      },
    ])
    const result = await q.listBotsForMachine(chain, "machine_1")
    expect(result[0]?.runtime).toBe("claude")
    expect(result[0]?.modelName).toBeNull()
  })

  it("defaults description to empty string when the profile row is missing", async () => {
    const chain = makeJoinChain([
      { id: "bot_1", name: "helper", discriminator: "1234", description: null, ownerName: "gustavo", ownerDiscriminator: "5678" },
    ])
    const result = await q.listBotsForMachine(chain, "machine_1")
    expect(result[0]?.description).toBe("")
  })
})

describe("bot limits", () => {
  it("admits 100 distinct onboarding bots and rejects an oversized request", () => {
    const payload = (count: number) => ({
      bots: Array.from({ length: count }, (_, index) => ({ id: `bot-${index}`, wakePrompt: "Welcome" })),
      leadBotId: "bot-0", action: { type: "finalize" },
    })
    expect(CommunityServerOnboardRequestSchema.safeParse(payload(100)).success).toBe(true)
    expect(CommunityServerOnboardRequestSchema.safeParse(payload(101)).success).toBe(false)
  })
  it("enforces 32-character names through create and patch", () => {
    const create = { machineId: "machine_1", runtime: "codex" }
    expect(CommunityBotCreateRequestSchema.safeParse({ ...create, name: "a".repeat(32) }).success).toBe(true)
    expect(CommunityBotCreateRequestSchema.safeParse({ ...create, name: "a".repeat(33) }).success).toBe(false)
    expect(CommunityBotPatchRequestSchema.safeParse({ name: "a".repeat(32) }).success).toBe(true)
    expect(CommunityBotPatchRequestSchema.safeParse({ name: "a".repeat(33) }).success).toBe(false)
  })
})

describe("bumpBotDailyActivityStatement", () => {

  it("handled: inserts (1,0) and ON CONFLICT bumps handled_count", async () => {
    const { sqlite, db } = createMigratedDatabase()
    try {
      const target = await q.createBot(db, { ownerId: "owner_1", name: "Counter", machineId: "machine_1", runtime: "codex" })
      const neighbor = await q.createBot(db, { ownerId: "owner_1", name: "Neighbor", machineId: "machine_1", runtime: "codex" })
      const day = "2026-07-31"
      const read = (botId: string, value: string) => sqlite.prepare("SELECT handled_count,sent_count FROM community_bot_daily_activity WHERE bot_id=? AND day=?").get(botId, value)
      await q.bumpBotDailyActivityStatement(db, target.botId, day, "handled")
      expect(read(target.botId, day)).toEqual({ handled_count: 1, sent_count: 0 })
      sqlite.prepare("UPDATE community_bot_daily_activity SET handled_count=6,sent_count=9 WHERE bot_id=? AND day=?").run(target.botId, day)
      sqlite.prepare("INSERT INTO community_bot_daily_activity (bot_id,day,handled_count,sent_count) VALUES (?,?,31,47)").run(neighbor.botId, day)
      sqlite.prepare("INSERT INTO community_bot_daily_activity (bot_id,day,handled_count,sent_count) VALUES (?,?,33,55)").run(target.botId, "2026-08-01")
      await q.bumpBotDailyActivityStatement(db, target.botId, day, "handled")
      await q.bumpBotDailyActivityStatement(db, target.botId, day, "handled")
      expect(read(target.botId, day)).toEqual({ handled_count: 8, sent_count: 9 })
      expect(read(neighbor.botId, day)).toEqual({ handled_count: 31, sent_count: 47 })
      expect(read(target.botId, "2026-08-01")).toEqual({ handled_count: 33, sent_count: 55 })
      expect(sqlite.pragma("foreign_key_check")).toEqual([])
    } finally { sqlite.close() }
  })

  it("sent: inserts (0,1) and ON CONFLICT bumps sent_count", async () => {
    const { sqlite, db } = createMigratedDatabase()
    try {
      const target = await q.createBot(db, { ownerId: "owner_1", name: "Counter", machineId: "machine_1", runtime: "codex" })
      const neighbor = await q.createBot(db, { ownerId: "owner_1", name: "Neighbor", machineId: "machine_1", runtime: "codex" })
      const day = "2026-07-31"
      const read = (botId: string, value: string) => sqlite.prepare("SELECT handled_count,sent_count FROM community_bot_daily_activity WHERE bot_id=? AND day=?").get(botId, value)
      await q.bumpBotDailyActivityStatement(db, target.botId, day, "sent")
      expect(read(target.botId, day)).toEqual({ handled_count: 0, sent_count: 1 })
      sqlite.prepare("UPDATE community_bot_daily_activity SET handled_count=6,sent_count=9 WHERE bot_id=? AND day=?").run(target.botId, day)
      sqlite.prepare("INSERT INTO community_bot_daily_activity (bot_id,day,handled_count,sent_count) VALUES (?,?,31,47)").run(neighbor.botId, day)
      sqlite.prepare("INSERT INTO community_bot_daily_activity (bot_id,day,handled_count,sent_count) VALUES (?,?,33,55)").run(target.botId, "2026-08-01")
      await q.bumpBotDailyActivityStatement(db, target.botId, day, "sent")
      await q.bumpBotDailyActivityStatement(db, target.botId, day, "sent")
      expect(read(target.botId, day)).toEqual({ handled_count: 6, sent_count: 11 })
      expect(read(neighbor.botId, day)).toEqual({ handled_count: 31, sent_count: 47 })
      expect(read(target.botId, "2026-08-01")).toEqual({ handled_count: 33, sent_count: 55 })
      expect(sqlite.pragma("foreign_key_check")).toEqual([])
    } finally { sqlite.close() }
  })
})
