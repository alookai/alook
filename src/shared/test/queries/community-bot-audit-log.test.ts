import { describe, it, expect } from "vitest"
import * as q from "../../src/db/queries/community/bot-audit-log"
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
  })

  it("exposes a reader", () => {
    expect(typeof q.listBotActivityEvents).toBe("function")
  })

  it("exposes the retention cap constant", () => {
    // Plan §Retention: 500 rows per bot. Locked here so a refactor
    // changing the constant surfaces as a test failure.
    expect(q.AUDIT_LOG_MAX_ROWS_PER_BOT).toBe(500)
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
