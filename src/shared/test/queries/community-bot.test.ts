import { describe, it, expect, vi } from "vitest"
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
    expect(typeof q.findPendingFriendRequest).toBe("function")
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
    expect(secondAttemptDiscriminator).toBe(computeDiscriminator(`${botId}:1`))
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

describe("bot limits", () => {
  it("cap is 20", () => {
    expect(COMMUNITY_BOT_LIMIT_PER_OWNER).toBe(20)
  })
  it("name max is 32", () => {
    expect(COMMUNITY_BOT_NAME_MAX).toBe(32)
  })
})
