import { describe, it, expect, vi } from "vitest"
import { drizzle } from "drizzle-orm/d1"
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
    expect(typeof q.listApprovalRequestsByDmMessageIds).toBe("function")
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

describe("getBotBinding", () => {
  function makeSelectChain(rows: unknown[]) {
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(() => Promise.resolve(rows))
    return chain
  }

  it("returns { machineId, runtime, modelName } when the binding exists (modelName defaults to null)", async () => {
    const chain = makeSelectChain([{ machineId: "machine_1", runtime: "codex", modelName: null }])
    const result = await q.getBotBinding(chain, "bot_1")
    expect(result).toEqual({ machineId: "machine_1", runtime: "codex", modelName: null })
  })

  it("surfaces a stored modelName", async () => {
    const chain = makeSelectChain([{ machineId: "machine_1", runtime: "claude", modelName: "claude-opus-4-6" }])
    const result = await q.getBotBinding(chain, "bot_1")
    expect(result).toEqual({ machineId: "machine_1", runtime: "claude", modelName: "claude-opus-4-6" })
  })

  it("returns null when no binding row matches", async () => {
    const chain = makeSelectChain([])
    const result = await q.getBotBinding(chain, "ghost_bot")
    expect(result).toBeNull()
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
