import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import * as q from "../../src/db/queries/community/bot-audit-log"
import type { Database } from "../../src/db"
import { BotAuditEventSchema, HostBotAuditEventFrameSchema } from "../../src/schemas"

/**
 * Smoke test — verifies the bot-audit-log query module exports the documented
 * helpers. Integration-level behaviour (batch atomicity, retention prune,
 * cursor pagination, soft-delete filter) is exercised in the
 * `tests/e2e/community-bot-audit-log.e2e.test.ts` suite where a real D1 lives.
 */
describe("community/bot-audit-log exports", () => {
  it("exposes writers", () => {
    expect(typeof q.insertBotActivityEventStatement).toBe("function")
    expect(typeof q.pruneBotActivityEventsStatement).toBe("function")
    expect(typeof q.insertBotActivityEventAndPrune).toBe("function")
    expect(typeof q.insertBotAuditWakeTrigger).toBe("function")
    expect(typeof q.insertBotAuditError).toBe("function")
  })

  it("exposes a reader", () => {
    expect(typeof q.listOwnedBotActivityEvents).toBe("function")
  })

  it("exposes the retention cap constant", () => {
    // Plan §Retention: 500 rows per bot. Locked here so a refactor
    // changing the constant surfaces as a test failure.
    expect(q.AUDIT_LOG_MAX_ROWS_PER_BOT).toBe(500)
  })
})

describe("listOwnedBotActivityEvents", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        isBot INTEGER NOT NULL DEFAULT 0,
        ownerUserId TEXT,
        deletedAt TEXT
      );
      CREATE TABLE community_bot_activity_event (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        session_id TEXT,
        launch_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    db = drizzle(sqlite) as unknown as Database

    const insertUser = sqlite.prepare(
      "INSERT INTO user (id, isBot, ownerUserId, deletedAt) VALUES (?, ?, ?, ?)",
    )
    insertUser.run("owner_1", 0, null, null)
    insertUser.run("owner_2", 0, null, null)
    insertUser.run("bot_1", 1, "owner_1", null)
    insertUser.run("empty_bot", 1, "owner_1", null)
    insertUser.run("foreign_bot", 1, "owner_2", null)
    insertUser.run("human_1", 0, "owner_1", null)
    insertUser.run("deleted_bot", 1, "owner_1", "2026-08-01T00:00:00.000Z")

    const insertEvent = sqlite.prepare(`
      INSERT INTO community_bot_activity_event
        (id, bot_id, session_id, launch_id, kind, payload, created_at)
      VALUES (?, ?, NULL, NULL, 'tool_call', '{"name":"read"}', ?)
    `)
    insertEvent.run("bae_d", "bot_1", "2026-08-04T00:00:00.000Z")
    insertEvent.run("bae_c", "bot_1", "2026-08-03T00:00:00.000Z")
    insertEvent.run("bae_b", "bot_1", "2026-08-03T00:00:00.000Z")
    insertEvent.run("bae_a", "bot_1", "2026-08-01T00:00:00.000Z")
    insertEvent.run("bae_foreign", "foreign_bot", "2026-08-05T00:00:00.000Z")
    insertEvent.run("bae_human", "human_1", "2026-08-05T00:00:00.000Z")
    insertEvent.run("bae_deleted", "deleted_bot", "2026-08-05T00:00:00.000Z")
  })

  afterEach(() => sqlite.close())

  it("returns a newest-first bounded page in exactly one select", async () => {
    const selectSpy = vi.spyOn(db, "select")
    const rows = await q.listOwnedBotActivityEvents(db, {
      botId: "bot_1",
      ownerUserId: "owner_1",
      limit: 3,
    })

    expect(selectSpy).toHaveBeenCalledTimes(1)
    expect(rows?.map((row) => row.id)).toEqual(["bae_d", "bae_c", "bae_b"])
  })

  it("keeps tied timestamps lossless with the composite cursor", async () => {
    const rows = await q.listOwnedBotActivityEvents(db, {
      botId: "bot_1",
      ownerUserId: "owner_1",
      beforeCreatedAt: "2026-08-03T00:00:00.000Z",
      beforeId: "bae_c",
      limit: 5,
    })

    expect(rows?.map((row) => row.id)).toEqual(["bae_b", "bae_a"])
  })

  it("returns an empty page for an owned live bot with no matching events", async () => {
    await expect(
      q.listOwnedBotActivityEvents(db, {
        botId: "empty_bot",
        ownerUserId: "owner_1",
        limit: 5,
      }),
    ).resolves.toEqual([])

    await expect(
      q.listOwnedBotActivityEvents(db, {
        botId: "bot_1",
        ownerUserId: "owner_1",
        beforeCreatedAt: "2025-01-01T00:00:00.000Z",
        beforeId: "bae_0",
        limit: 5,
      }),
    ).resolves.toEqual([])
  })

  it.each([
    ["foreign bot", "foreign_bot"],
    ["human", "human_1"],
    ["deleted bot", "deleted_bot"],
    ["missing bot", "missing_bot"],
  ])("returns null for a %s", async (_label, botId) => {
    await expect(
      q.listOwnedBotActivityEvents(db, {
        botId,
        ownerUserId: "owner_1",
        limit: 5,
      }),
    ).resolves.toBeNull()
  })
})

describe("BotAuditEventSchema — payload discriminated union", () => {
  it("accepts a cli_invocation payload", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "cli_invocation",
      payload: { subcommand: "send" },
    })
    expect(r.success).toBe(true)
  })
  it("accepts a tool_call payload", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "tool_call",
      payload: { name: "Read" },
    })
    expect(r.success).toBe(true)
  })
  it("accepts a thinking payload with truncated + chars", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "thinking",
      payload: { text: "hmm", truncated: false, chars: 3 },
    })
    expect(r.success).toBe(true)
  })
  it("accepts a wake_trigger payload with the six required fields", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "wake_trigger",
      payload: {
        messageId: "msg_1",
        channel: "/srv_1/general",
        seq: 12,
        senderId: "u_human",
        senderHandle: "@gustavo#0042",
        reason: "unread",
      },
    })
    expect(r.success).toBe(true)
  })
  it("accepts wake_trigger with reason=mention", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "wake_trigger",
      payload: {
        messageId: "msg_1",
        channel: "/srv_1/general",
        seq: 12,
        senderId: "u_human",
        senderHandle: "@gustavo#0042",
        reason: "mention",
      },
    })
    expect(r.success).toBe(true)
  })
  it("rejects wake_trigger with a missing required field", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "wake_trigger",
      payload: {
        // messageId missing
        channel: "/srv_1/general",
        seq: 12,
        senderId: "u_human",
        senderHandle: "@gustavo#0042",
        reason: "unread",
      },
    })
    expect(r.success).toBe(false)
  })
  it("rejects wake_trigger with an unknown reason", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "wake_trigger",
      payload: {
        messageId: "msg_1",
        channel: "/srv_1/general",
        seq: 12,
        senderId: "u_human",
        senderHandle: "@gustavo#0042",
        reason: "shouted",
      },
    })
    expect(r.success).toBe(false)
  })
  it("accepts an error payload with scope/code/message/model", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "error",
      payload: { scope: "handshake_timeout", code: "handshake_timeout", message: "no response after 60s", model: "claude-bogus" },
    })
    expect(r.success).toBe(true)
  })
  it("rejects an error payload with a bad scope", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "error",
      payload: { scope: "meltdown", code: "x", message: "m", model: null },
    })
    expect(r.success).toBe(false)
  })
  it("rejects a kind/payload mismatch", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "tool_call",
      payload: { subcommand: "send" },
    })
    expect(r.success).toBe(false)
  })
  it("rejects an unknown kind", () => {
    const r = BotAuditEventSchema.safeParse({
      kind: "shell",
      payload: { name: "bash" },
    })
    expect(r.success).toBe(false)
  })
})

describe("HostBotAuditEventFrameSchema", () => {
  it("accepts a frame with optional sessionId/launchId", () => {
    const r = HostBotAuditEventFrameSchema.safeParse({
      type: "bot_audit_event",
      agentId: "bot_1",
      sessionId: "s_1",
      launchId: "l_1",
      event: { kind: "cli_invocation", payload: { subcommand: "send" } },
    })
    expect(r.success).toBe(true)
  })
  it("accepts a frame without sessionId/launchId", () => {
    const r = HostBotAuditEventFrameSchema.safeParse({
      type: "bot_audit_event",
      agentId: "bot_1",
      event: { kind: "thinking", payload: { text: "x", truncated: false, chars: 1 } },
    })
    expect(r.success).toBe(true)
  })
  it("rejects an empty agentId (must be at least one char)", () => {
    const r = HostBotAuditEventFrameSchema.safeParse({
      type: "bot_audit_event",
      agentId: "",
      event: { kind: "tool_call", payload: { name: "Read" } },
    })
    expect(r.success).toBe(false)
  })
})
