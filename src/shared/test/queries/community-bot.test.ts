import { describe, it, expect, vi } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3"
import Sqlite from "better-sqlite3"
import * as q from "../../src/db/queries/community/bot"
import {
  communityBotSyntheticEmail,
  COMMUNITY_BOT_LIMIT_PER_OWNER,
  COMMUNITY_BOT_NAME_MAX,
} from "../../src/constants"
import { computeDiscriminator } from "../../src/lib/discriminator"

/**
 * Smoke test — verifies the community/bot module exports the documented
 * helpers. Integration-level behaviour (batch atomicity, cross-owner
 * isolation, deletedAt filter) is exercised end-to-end in the tests under
 * `tests/e2e/community-bots.e2e.test.ts` where a real D1 lives.
 */
describe("community/bot exports", () => {
  it("exposes read helpers", () => {
    expect(typeof q.listBotsForOwner).toBe("function")
    expect(typeof q.getBotOwnedBy).toBe("function")
    expect(typeof q.getLiveBotAvatar).toBe("function")
    expect(typeof q.countLiveBotsForOwner).toBe("function")
    expect(typeof q.getBotBinding).toBe("function")
    expect(typeof q.listBotsForMachine).toBe("function")
    expect(typeof q.listBotsBoundToMachine).toBe("function")
    expect(typeof q.getMachineForOwner).toBe("function")
  })

  it("exposes bot-activity heatmap helpers", () => {
    expect(typeof q.bumpBotDailyActivityStatement).toBe("function")
    expect(typeof q.getBotDailyActivity).toBe("function")
    expect(typeof q.getBotDailyActivityForOwner).toBe("function")
  })

  it("exposes write helpers", () => {
    expect(typeof q.createBot).toBe("function")
    expect(typeof q.updateBot).toBe("function")
    expect(typeof q.softDeleteBot).toBe("function")
    expect(typeof q.assertNoLiveBots).toBe("function")
  })

  it("exposes approval-request helpers", () => {
    expect(typeof q.getApprovalRequest).toBe("function")
    expect(typeof q.listPendingApprovalsForBot).toBe("function")
    expect(typeof q.findPendingJoinRequest).toBe("function")
    expect(typeof q.createApprovalRequestStatement).toBe("function")
    expect(typeof q.resolveApprovalRequest).toBe("function")
    expect(typeof q.getApprovalRequestByDmMessageId).toBe("function")
  })

  it("exports OwnerHasBotsError as a real Error subclass", () => {
    const e = new q.OwnerHasBotsError("boom")
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe("OwnerHasBotsError")
  })
})

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
    const userValues: unknown[] = []
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          userValues.push(values)
          return {
            onConflictDoUpdate: vi.fn(() => ({ __stmt: "profile" })),
          }
        }),
      })),
      batch: vi.fn(async () => []),
    }

    await q.createBot(db as never, {
      ownerId: "owner_1",
      name: "helper",
      description: "does things",
      machineId: "machine_1",
      runtime: "codex",
    })

    const botUser = userValues[0] as { id: string; discriminator: string }
    expect(botUser.discriminator).toBe(computeDiscriminator(botUser.id))
    expect(botUser.discriminator).toMatch(/^\d{4}$/)
    expect(userValues[1]).toEqual(expect.objectContaining({ instruction: "does things" }))
    expect(userValues[2]).toEqual(expect.objectContaining({ aboutMe: "does things" }))
    expect(db.batch).toHaveBeenCalledOnce()
  })

  it("on a discriminator collision, retries the WHOLE 3-statement batch with a salted discriminator", async () => {
    // Every statement in the batch (`user`, `communityBotBinding`,
    // `communityUserProfile`) gets rebuilt per attempt, so all three of an
    // attempt's `.values(...)` payloads must carry the SAME (salted)
    // discriminator that attempt used — not just the user row.
    const userValues: Array<{ id: string; discriminator: string }> = []
    const uniqueErr = Object.assign(new Error("UNIQUE constraint failed: user.name, user.discriminator"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    })
    const batch = vi.fn().mockRejectedValueOnce(uniqueErr).mockResolvedValueOnce([])
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          userValues.push(values as { id: string; discriminator: string })
          return {
            onConflictDoUpdate: vi.fn(() => ({ __stmt: "profile" })),
          }
        }),
      })),
      batch,
    }

    const result = await q.createBot(db as never, {
      ownerId: "owner_1",
      name: "helper",
      description: "does things",
      machineId: "machine_1",
      runtime: "codex",
    })

    // 2 attempts × 3 statements (user, binding, profile) each pushing values.
    expect(userValues).toHaveLength(6)
    expect(batch).toHaveBeenCalledTimes(2)

    const botId = result.botId
    const firstAttemptDiscriminator = userValues[0]!.discriminator
    const secondAttemptDiscriminator = userValues[3]!.discriminator
    expect(firstAttemptDiscriminator).toBe(computeDiscriminator(botId))
    // Salt scheme is now `id:width:attempt`; the first retry stays at width 4.
    expect(secondAttemptDiscriminator).toBe(computeDiscriminator(`${botId}:4:1`, 4))
    expect(secondAttemptDiscriminator).not.toBe(firstAttemptDiscriminator)

    // The winning (second) attempt's discriminator is what's returned.
    expect(result.discriminator).toBe(secondAttemptDiscriminator)
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
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve(rows))
    return chain
  }

  it("returns reasoning effort and revision when listing an owner's bots", async () => {
    await expect(q.listBotsForOwner(makeOwnerListChain([storedBot]), "owner_1")).resolves.toEqual([
      storedBot,
    ])
  })

  it("returns reasoning effort and revision from the owner-scoped lookup", async () => {
    await expect(q.getBotOwnedBy(makeLimitedReadChain([storedBot]), "bot_1", "owner_1")).resolves.toEqual(
      storedBot,
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
    const chain = makeSelectChain([{ machineId: "machine_1", runtime: "codex", modelName: null }])
    const result = await q.getBotBinding(chain, "bot_1")
    expect(result).toEqual({
      machineId: "machine_1",
      runtime: "codex",
      modelName: null,
      reasoningEffort: null,
      runtimeConfigRevision: 0,
    })
  })

  it("surfaces a stored modelName", async () => {
    const chain = makeSelectChain([{ machineId: "machine_1", runtime: "claude", modelName: "claude-opus-4-6" }])
    const result = await q.getBotBinding(chain, "bot_1")
    expect(result).toEqual({
      machineId: "machine_1",
      runtime: "claude",
      modelName: "claude-opus-4-6",
      reasoningEffort: null,
      runtimeConfigRevision: 0,
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
  it("cap is 20", () => {
    expect(COMMUNITY_BOT_LIMIT_PER_OWNER).toBe(20)
  })
  it("name max is 32", () => {
    expect(COMMUNITY_BOT_NAME_MAX).toBe(32)
  })
})

describe("bumpBotDailyActivityStatement", () => {
  const fakeDb = drizzle({} as never)

  it("handled: inserts (1,0) and ON CONFLICT bumps handled_count", () => {
    const { sql: text, params } = q
      .bumpBotDailyActivityStatement(fakeDb, "bot_1", "2026-07-31", "handled")
      .toSQL()
    // upsert on the (bot_id, day) PK
    expect(text).toContain('insert into "community_bot_daily_activity"')
    expect(text).toContain("on conflict")
    // seeds handled=1/sent=0, updates handled_count = handled_count + 1
    expect(text).toContain('"handled_count" = "community_bot_daily_activity"."handled_count" + 1')
    expect(text).not.toContain('"sent_count" = ')
    expect(params).toEqual(["bot_1", "2026-07-31", 1, 0])
  })

  it("sent: inserts (0,1) and ON CONFLICT bumps sent_count", () => {
    const { sql: text, params } = q
      .bumpBotDailyActivityStatement(fakeDb, "bot_1", "2026-07-31", "sent")
      .toSQL()
    expect(text).toContain('"sent_count" = "community_bot_daily_activity"."sent_count" + 1')
    expect(text).not.toContain('"handled_count" = ')
    expect(params).toEqual(["bot_1", "2026-07-31", 0, 1])
  })
})
