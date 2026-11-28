import { beforeEach, describe, it, expect, vi } from "vitest"
import { eq } from "drizzle-orm"
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3"
import Sqlite from "better-sqlite3"
import { communityAgentRunnerKey, communityBotBinding } from "../../src/db/community-machine-schema"
import { communityBotDailyTokenUsage, communityServer, communityServerMember } from "../../src/db/community-schema"
import { user } from "../../src/db/schema"
import * as q from "../../src/db/queries/community/bot"
import { createMigratedDb } from "../helpers/migrated-db"
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

function createMigratedDatabase() {
  const { sqlite, db, batch, errors } = createMigratedDb()
  try {
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

it("resolves bot binding, wake and owner-scoped membership on the migrated schema", async () => {
  const { sqlite, db } = createMigratedDatabase()
  try {
    await db.insert(user).values([
      { id: "other-owner", name: "Other owner", email: "other-owner@example.test" },
      { id: "ready-bot", name: "Ready", email: "ready-bot@example.test", discriminator: "0123", isBot: true, ownerUserId: "owner_1" },
      { id: "unbound-bot", name: "Unbound", email: "unbound-bot@example.test", isBot: true, ownerUserId: "owner_1" },
      { id: "deleted-bot", name: "Deleted", email: "deleted-bot@example.test", isBot: true, ownerUserId: "owner_1", deletedAt: "2026-01-02" },
    ]).run()
    await db.insert(communityBotBinding).values([
      { userId: "ready-bot", machineId: "machine_1", runtime: "codex", modelName: "gpt-5", reasoningEffort: "high", runtimeConfigRevision: 7 },
      { userId: "deleted-bot", machineId: "machine_1", runtime: "codex" },
    ]).run()
    await db.insert(communityServer).values({ id: "server", name: "Server", ownerId: "owner_1" }).run()
    await db.insert(communityServerMember).values({ serverId: "server", userId: "ready-bot" }).run()

    await expect(q.getBotBindingWithOwner(db, "ready-bot")).resolves.toEqual({
      machineId: "machine_1", runtime: "codex", ownerUserId: "owner_1",
      name: "Ready", discriminator: "0123", isActive: true,
    })
    await expect(q.getBotBindingWithOwner(db, "unbound-bot")).resolves.toBeNull()
    await expect(q.getBotBindingWithOwner(db, "deleted-bot")).resolves.toBeNull()
    await expect(q.getBotWakeContext(db, "ready-bot")).resolves.toEqual({
      state: "ready", botUserId: "ready-bot", name: "Ready", discriminator: "0123",
      machineId: "machine_1", runtime: "codex", modelName: "gpt-5", reasoningEffort: "high",
      runtimeConfigRevision: 7, ownerUserId: "owner_1",
    })
    await expect(q.getBotWakeContext(db, "unbound-bot")).resolves.toEqual({ state: "bot_unbound" })
    await expect(q.getBotWakeContext(db, "deleted-bot")).resolves.toEqual({ state: "bot_deleted" })
    await expect(q.listBotServerMemberships(db, "ready-bot", "owner_1")).resolves.toEqual(["server"])
    await expect(q.listBotServerMemberships(db, "ready-bot", "other-owner")).resolves.toEqual([])
    await expect(q.listBotsBoundToMachine(db, "machine_1", "owner_1")).resolves.toEqual([{ id: "ready-bot", name: "Ready" }])
    await expect(q.listBotsBoundToMachine(db, "machine_1", "other-owner")).resolves.toEqual([])
    await expect(q.listBotsBoundToMachine(db, "missing-machine", "owner_1")).resolves.toEqual([])
  } finally {
    sqlite.close()
  }
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

it("persists owner-scoped avatar, refresh and deletion for only the target bot", async () => {
  const { sqlite, db } = createMigratedDatabase()
  try {
    const ownerId = "owner_1"
    const machineId = "machine_1"
    const runtime = "codex-cli"
    const { botId } = await q.createBot(db, { ownerId, machineId, runtime, name: "Target", description: "target instruction" })
    const { botId: neighbor } = await q.createBot(db, { ownerId, machineId, runtime, name: "Neighbor" })
    await db.insert(user).values({ id: "other-owner", name: "Other", email: "other-owner@example.test" }).run()
    await db.insert(communityServer).values({ id: "server", name: "Server", ownerId }).run()
    await db.insert(communityServerMember).values([botId, neighbor].map(userId => ({ serverId: "server", userId }))).run()
    await db.insert(communityAgentRunnerKey).values([botId, neighbor].map(agentId => ({
      userId: ownerId, machineId, agentId, runnerKeyHash: "hash-" + agentId, doName: "runner-" + agentId,
    }))).run()

    const avatar = { objectKey: "avatar-v1.jpg", stableUrl: "/avatar.jpg" }
    await expect(q.publishOwnedBotAvatar(db, botId, "other-owner", avatar)).resolves.toBeNull()
    await expect(q.publishOwnedBotAvatar(db, botId, ownerId, avatar)).resolves.toEqual({
      previous: { avatarVersion: 0, avatarObjectKey: null },
      current: { id: botId, image: avatar.stableUrl, avatarVersion: 1, avatarObjectKey: avatar.objectKey },
    })
    await expect(q.updateBot(db, botId, "other-owner", { name: "Wrong" })).resolves.toBeNull()
    await expect(q.updateBot(db, botId, ownerId, { name: "Renamed" })).resolves.toMatchObject({
      name: "Renamed", description: "target instruction", avatarVersion: 1, image: avatar.stableUrl,
    })
    const refreshedAt = "2026-09-07T06:00:00Z"
    await q.touchBotRefreshContext(db, botId, refreshedAt)

    await expect(q.softDeleteBot(db, botId, "other-owner")).resolves.toBe(false)
    await expect(q.getBotBinding(db, botId)).resolves.toMatchObject({ machineId })
    await expect(q.listBotServerMemberships(db, botId, ownerId)).resolves.toEqual(["server"])
    const [before] = await db.select().from(communityAgentRunnerKey).where(eq(communityAgentRunnerKey.agentId, botId))
    expect(before?.revokedAt).toBeNull()
    await expect(q.softDeleteBot(db, botId, ownerId)).resolves.toBe(true)
    await expect(q.softDeleteBot(db, botId, ownerId)).resolves.toBe(false)
    await q.touchBotRefreshContext(db, botId, "2026-09-08T06:00:00Z")

    const [removed] = await db.select().from(user).where(eq(user.id, botId))
    expect(removed).toMatchObject({ deletedAt: expect.any(String), lastRefreshContextAt: refreshedAt })
    await expect(q.getBotBinding(db, botId)).resolves.toBeNull()
    await expect(q.listBotServerMemberships(db, botId, ownerId)).resolves.toEqual([])
    await expect(q.getLiveBotAvatar(db, botId)).resolves.toBeNull()
    const [revoked] = await db.select().from(communityAgentRunnerKey).where(eq(communityAgentRunnerKey.agentId, botId))
    expect(revoked?.revokedAt).toBe(removed?.deletedAt)
    await expect(q.getBotBinding(db, neighbor)).resolves.toMatchObject({ machineId })
    await expect(q.listBotServerMemberships(db, neighbor, ownerId)).resolves.toEqual(["server"])
    const [retained] = await db.select().from(communityAgentRunnerKey).where(eq(communityAgentRunnerKey.agentId, neighbor))
    expect(retained?.revokedAt).toBeNull()
  } finally {
    sqlite.close()
  }
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
        model_observation TEXT,
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
    chain.crossJoin = vi.fn(() => chain)
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

it("reads daily activity and usage only for live owned bots from the requested day", async () => {
  const { db, sqlite } = createMigratedDatabase()
  try {
    await db.insert(user).values([
      { id: "other-owner", name: "Other owner", email: "other-owner@example.test" },
      { id: "target", name: "Target", email: "target@example.test", isBot: true, ownerUserId: "owner_1" },
      { id: "gone", name: "Gone", email: "gone@example.test", isBot: true, ownerUserId: "owner_1", deletedAt: "2026-09-07T06:00:00Z" },
      { id: "foreign", name: "Foreign", email: "foreign@example.test", isBot: true, ownerUserId: "other-owner" },
    ]).run()
    const since = "2026-09-07"
    const days = [
      { botId: "target", day: "2026-09-08" },
      { botId: "target", day: "2026-09-06" },
      { botId: "target", day: since },
      { botId: "gone", day: since },
      { botId: "foreign", day: since },
    ]
    await db.insert(communityBotDailyTokenUsage).values(days.map(row => ({
      ...row, inputTokens: 6, outputTokens: 2, cacheTokens: null, updatedAt: row.day + "T12:00:00Z",
    }))).run()
    const usage = await q.getBotDailyTokenUsageForOwner(db, "owner_1", since)
    const expectedDays = [since, "2026-09-08"]
    expect([...usage]).toEqual([["target", expectedDays.map(day => ({ botId: "target", day, metrics: { input: 6, output: 2, cache: null } }))]])
  } finally {
    sqlite.close()
  }
})


describe("activation catch-up on migrated SQLite", () => {
  it("uses indexed latest-message lookups only for the bot's participating scopes", async () => {
    const { sqlite, db, batch } = createMigratedDatabase()
    try {
      const { botId } = await q.createBot(db, { ownerId: "owner_1", name: "activation", machineId: "machine_1", runtime: "codex-cli" })
      sqlite.prepare("UPDATE community_bot_binding SET is_active=0 WHERE user_id=?").run(botId)
      sqlite.exec(`
        INSERT INTO community_server(id,name,discriminator,owner_id,created_at)
          VALUES ('joined','Joined','1111','owner_1','2026-01-01'), ('foreign','Foreign','2222','owner_1','2026-01-01');
        INSERT INTO community_category(id,server_id,name,private)
          VALUES ('private','joined','Private',1);
        INSERT INTO community_channel(id,server_id,type,created_at) VALUES
          ('history','joined','text','2026-01-01'), ('legacy','joined','text','2026-01-01'),
          ('empty','joined','text','2026-01-01'), ('foreign-history','foreign','text','2026-01-01');
        INSERT INTO community_channel(id,server_id,type,parent_channel_id,created_at) VALUES
          ('joined-thread','joined','thread','history','2026-01-01'),
          ('unjoined-thread','joined','thread','history','2026-01-01');
        INSERT INTO community_channel(id,server_id,type,category_id,created_at)
          VALUES ('hidden','joined','text','private','2026-01-01');
        INSERT INTO community_channel(id,type,created_at) VALUES ('blocked-dm','dm','2026-01-01');
      `)
      sqlite.prepare("INSERT INTO community_server_member(id,server_id,user_id,joined_at) VALUES('membership','joined',?,'2026-01-01')").run(botId)
      sqlite.prepare("INSERT INTO community_channel_member(id,channel_id,user_id,relation,added_at) VALUES('notify','joined-thread',?,'notify','2026-01-01'),('self','blocked-dm',?,'access','2026-01-01'),('peer','blocked-dm','owner_1','access','2026-01-01')").run(botId, botId)
      sqlite.prepare("INSERT INTO community_friendship(id,requester_id,addressee_id,status,created_at,updated_at) VALUES('block',?,'owner_1','blocked','2026-01-01','2026-01-01')").run(botId)
      const insert = sqlite.prepare("INSERT INTO community_message(id,channel_id,author_id,created_at,seq) VALUES(?,?,'owner_1',?,?)")
      sqlite.transaction(() => {
        for (const channelId of ["history", "foreign-history"]) {
          for (let seq = 1; seq <= 5000; seq++) insert.run(`${channelId}-${seq}`, channelId, "2026-01-01", seq)
        }
        for (const channelId of ["joined-thread", "unjoined-thread", "hidden", "blocked-dm"]) insert.run(channelId, channelId, "2026-01-01", 1)
        insert.run("legacy-a", "legacy", "2026-01-01", 0)
        insert.run("legacy-b", "legacy", "2026-01-02", 0)
        insert.run("legacy-newer-date", "history", "2026-02-01", 0)
      })()
      batch.mockClear()

      await expect(q.setBotActive(db, botId, "owner_1", true)).resolves.toMatchObject({ state: "updated", bot: { isActive: true } })
      expect(sqlite.prepare("SELECT channel_id, last_read_message_id, last_read_seq FROM community_read_state WHERE user_id=? ORDER BY channel_id").all(botId)).toEqual([
        { channel_id: "history", last_read_message_id: "history-5000", last_read_seq: 5000 },
        { channel_id: "joined-thread", last_read_message_id: "joined-thread", last_read_seq: 1 },
        { channel_id: "legacy", last_read_message_id: "legacy-b", last_read_seq: 0 },
      ])
      const query = batch.mock.calls[0]![0][0]!.toSQL()
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ detail: string }>
      expect(plan.some(row => /SEARCH activation_latest_message USING INDEX uq_community_message_channel_seq/.test(row.detail))).toBe(true)
      expect(plan.some(row => /SCAN activation_(?:message|channel|latest_message)\b/.test(row.detail))).toBe(false)
      expect(sqlite.prepare("SELECT revision FROM community_read_state_revision WHERE user_id=?").get(botId)).toEqual({ revision: 1 })
      sqlite.prepare("UPDATE community_bot_binding SET is_active=0 WHERE user_id=?").run(botId)
      insert.run("joined-thread-2", "joined-thread", "2026-01-02", 2)
      const executeBatch = db.batch.bind(db)
      db.batch = (async statements => {
        sqlite.prepare("DELETE FROM community_channel_member WHERE id='notify'").run()
        sqlite.prepare("INSERT INTO community_channel(id,server_id,type,parent_channel_id,created_at) VALUES('late-thread','joined','thread','history','2026-01-02')").run()
        sqlite.prepare("INSERT INTO community_channel_member(id,channel_id,user_id,relation,added_at) VALUES('late-notify','late-thread',?,'notify','2026-01-02')").run(botId)
        insert.run("late-message", "late-thread", "2026-01-02", 1)
        return executeBatch(statements)
      }) as typeof db.batch
      await expect(q.setBotActive(db, botId, "owner_1", true)).resolves.toMatchObject({ state: "updated" })
      expect(sqlite.prepare("SELECT last_read_seq FROM community_read_state WHERE user_id=? AND channel_id='joined-thread'").get(botId)).toEqual({ last_read_seq: 1 })
      expect(sqlite.prepare("SELECT last_read_message_id FROM community_read_state WHERE user_id=? AND channel_id='late-thread'").get(botId)).toEqual({ last_read_message_id: "late-message" })
      expect(sqlite.pragma("foreign_key_check")).toEqual([])
    } finally { sqlite.close() }
  })
})

describe("native model observations", () => {
  it("clears only on provider change, scopes clearing to the owner, and fences old reports after switching back", async () => {
    const { sqlite, db } = createMigratedDatabase()
    try {
      const { botId } = await q.createBot(db, { ownerId: "owner_1", name: "switched", machineId: "machine_1", runtime: "codex-cli" })
      const report = { agentId: botId, backendId: "codex-cli", runtimeConfigRevision: 0, sessionInstanceId: "old-epoch", model: "native-old", source: "response" as const, observedAt: "2026-11-17T02:00:00.000Z" }
      const read = async () => (await q.listBotsForOwner(db, "owner_1")).find(bot => bot.id === botId)!
      const desired = { runtime: "claude", modelName: "claude-opus-4-6", reasoningEffort: null }
      await q.recordBotModelObservation(db, "owner_1", "machine_1", report)
      expect(await q.updateBotRuntimeConfig(db, botId, "owner_2", desired)).toBeNull()
      expect((await read()).modelObservation?.model).toBe("native-old")
      await q.updateBotRuntimeConfig(db, botId, "owner_1", { ...desired, runtime: "codex-cli" })
      expect((await read()).modelObservation?.model).toBe("native-old")
      await q.updateBotRuntimeConfig(db, botId, "owner_1", desired)
      expect(sqlite.prepare("SELECT model_observation FROM community_bot_binding WHERE user_id=?").get(botId)).toEqual({ model_observation: null })
      await q.recordBotModelObservation(db, "owner_1", "machine_1", report)
      expect((await read()).modelObservation).toBeUndefined()
      await q.updateBotRuntimeConfig(db, botId, "owner_1", { ...desired, runtime: "codex-cli" })
      await q.recordBotModelObservation(db, "owner_1", "machine_1", { ...report, observedAt: "2026-11-17T03:00:00.000Z" })
      expect((await read()).modelObservation).toBeUndefined()
      await q.recordBotModelObservation(db, "owner_1", "machine_1", { ...report, runtimeConfigRevision: 3, sessionInstanceId: "new-epoch", model: "native-new" })
      expect((await read()).modelObservation?.model).toBe("native-new")
    } finally { sqlite.close() }
  })
  it("applies the additive migration, preserves requested intent, and rejects older or foreign observations atomically", async () => {
    const { sqlite, db } = createMigratedDatabase()
    try {
      const { botId } = await q.createBot(db, { ownerId: "owner_1", name: "observed", description: "", machineId: "machine_1", runtime: "codex", modelName: "requested" })
      expect(sqlite.prepare("SELECT model_observation FROM community_bot_binding WHERE user_id=?").get(botId)).toEqual({ model_observation: null })
      const report = { agentId: botId, backendId: "codex", runtimeConfigRevision: 0, sessionInstanceId: "epoch", model: "served", provider: "upstream", source: "response" as const, responseId: "reply", observedAt: "2026-11-17T10:00:00.000+08:00" }
      await q.recordBotModelObservation(db, "owner_1", "machine_1", report)
      const stored = () => sqlite.prepare("SELECT model_name,model_observation FROM community_bot_binding WHERE user_id=?").get(botId) as { model_name: string; model_observation: string }
      expect(stored().model_name).toBe("requested")
      expect(JSON.parse(stored().model_observation)).toEqual({ ...report, machineId: "machine_1", observedAt: "2026-11-17T02:00:00.000Z" })
      for (const [owner, machine, payload] of [
        ["owner_2", "machine_1", report], ["owner_1", "machine_2", report],
        ["owner_1", "machine_1", report],
        ["owner_1", "machine_1", { ...report, backendId: "claude" }],
        ["owner_1", "machine_1", { ...report, observedAt: "2026-11-17T01:59:59.000Z" }],
      ] as const) await q.recordBotModelObservation(db, owner, machine, { ...payload, model: "must-not-win" })
      expect(JSON.parse(stored().model_observation).model).toBe("served")
      const mine = await q.listBotsForOwner(db, "owner_1")
      expect(mine.find(bot => bot.id === botId)?.modelObservation?.model).toBe("served")
      expect(await q.listBotsForOwner(db, "owner_2")).toEqual([])
      sqlite.prepare("UPDATE community_bot_binding SET is_active=0 WHERE user_id=?").run(botId)
      await q.recordBotModelObservation(db, "owner_1", "machine_1", { ...report, model: "inactive", observedAt: "2026-11-17T02:01:00.000Z" })
      expect(JSON.parse(stored().model_observation).model).toBe("served")
      sqlite.prepare("UPDATE community_bot_binding SET runtime='claude' WHERE user_id=?").run(botId)
      expect((await q.listBotsForOwner(db, "owner_1"))[0]?.modelObservation).toBeUndefined()
    } finally { sqlite.close() }
  })
})
