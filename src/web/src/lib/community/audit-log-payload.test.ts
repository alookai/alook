import { describe, it, expect } from "vitest"
import { parseAuditLogPayload } from "./audit-log-payload"

describe("parseAuditLogPayload", () => {
  it("parses a well-shaped cli_invocation payload", () => {
    const p = parseAuditLogPayload("cli_invocation", JSON.stringify({ subcommand: "send" }))
    expect(p).toEqual({ subcommand: "send" })
  })
  it("parses a well-shaped tool_call payload (name only)", () => {
    const p = parseAuditLogPayload("tool_call", JSON.stringify({ name: "read" }))
    expect(p).toEqual({ name: "read" })
  })
  it("parses a bash tool_call payload with a `target` at the 240-char cap", () => {
    const t = "x".repeat(240)
    const p = parseAuditLogPayload(
      "tool_call",
      JSON.stringify({ name: "bash", target: t }),
    )
    expect(p).toEqual({ name: "bash", target: t })
  })
  it("rejects a tool_call `target` longer than 240 chars", () => {
    const long = "x".repeat(241)
    expect(parseAuditLogPayload("tool_call", JSON.stringify({ name: "bash", target: long }))).toBe(
      null,
    )
  })
  it("gracefully strips a legacy `command` field (Zod strip-unknown)", () => {
    const p = parseAuditLogPayload(
      "tool_call",
      JSON.stringify({ name: "bash", command: "rm -rf tmp" }),
    )
    expect(p).toEqual({ name: "bash" })
  })
  it("parses a well-shaped thinking payload", () => {
    const p = parseAuditLogPayload(
      "thinking",
      JSON.stringify({ text: "hmm", truncated: false, chars: 3 }),
    )
    expect(p).toEqual({ text: "hmm", truncated: false, chars: 3 })
  })
  it("parses only daemon-accepted turn_interrupt payloads", () => {
    expect(parseAuditLogPayload("turn_interrupt", JSON.stringify({ status: "accepted" }))).toEqual({
      status: "accepted",
    })
    expect(parseAuditLogPayload("turn_interrupt", JSON.stringify({ status: "stopped" }))).toBe(null)
  })
  it("parses a well-shaped wake_trigger payload", () => {
    const payload = {
      messageId: "m_1",
      channel: "/srv/general",
      seq: 42,
      senderId: "u_1",
      senderHandle: "@alice#1234",
      reason: "unread" as const,
    }
    expect(parseAuditLogPayload("wake_trigger", JSON.stringify(payload))).toEqual(payload)
  })
  it("parses a well-shaped model_changed payload (null-able from/to)", () => {
    expect(parseAuditLogPayload("model_changed", JSON.stringify({ from: null, to: "claude-opus-4-6" }))).toEqual({
      from: null,
      to: "claude-opus-4-6",
    })
  })
  it("parses a well-shaped provider_changed payload (required from/to runtimes)", () => {
    expect(
      parseAuditLogPayload("provider_changed", JSON.stringify({ from: "claude", to: "codex" })),
    ).toEqual({ from: "claude", to: "codex" })
  })
  it("rejects a provider_changed payload missing from/to", () => {
    expect(parseAuditLogPayload("provider_changed", JSON.stringify({ from: "claude" }))).toBe(null)
  })
  it("parses a well-shaped session_reset payload (single/reset_all trigger)", () => {
    expect(parseAuditLogPayload("session_reset", JSON.stringify({ trigger: "single" }))).toEqual({
      trigger: "single",
    })
    expect(parseAuditLogPayload("session_reset", JSON.stringify({ trigger: "reset_all" }))).toEqual({
      trigger: "reset_all",
    })
  })
  it("degrades a legacy empty session_reset payload to null (written before trigger existed)", () => {
    // Rows written by the old dispatch-time route carried `{}` — after the
    // schema tightened to require `trigger`, they parse to null rather than
    // throwing, and RowBody renders the static reset text (never a blank row).
    expect(parseAuditLogPayload("session_reset", JSON.stringify({}))).toBe(null)
  })
  it("rejects a session_reset payload with an out-of-domain trigger", () => {
    expect(parseAuditLogPayload("session_reset", JSON.stringify({ trigger: "nap" }))).toBe(null)
  })
  it("parses a well-shaped nap payload (trigger literal)", () => {
    expect(parseAuditLogPayload("nap", JSON.stringify({ trigger: "nap" }))).toEqual({ trigger: "nap" })
  })
  it("degrades a legacy empty nap payload to null", () => {
    expect(parseAuditLogPayload("nap", JSON.stringify({}))).toBe(null)
  })
  it("rejects a nap payload with an out-of-domain trigger (no cross-kind smuggle)", () => {
    expect(parseAuditLogPayload("nap", JSON.stringify({ trigger: "single" }))).toBe(null)
  })
  it("parses a well-shaped error payload (so history rows keep their message, not the fallback)", () => {
    const payload = {
      scope: "handshake_timeout" as const,
      code: "handshake_timeout",
      message: "Launch failed — model claude-bogus never handshaked within 60s",
      model: "claude-bogus",
    }
    expect(parseAuditLogPayload("error", JSON.stringify(payload))).toEqual(payload)
  })
  it("parses an error payload with a null model", () => {
    const payload = { scope: "spawn" as const, code: "ENOENT", message: "not found", model: null }
    expect(parseAuditLogPayload("error", JSON.stringify(payload))).toEqual(payload)
  })
  it("returns null on an error payload with a bad scope", () => {
    expect(
      parseAuditLogPayload("error", JSON.stringify({ scope: "meltdown", code: "x", message: "m", model: null })),
    ).toBe(null)
  })
  it("returns null on invalid JSON — the whole page must not 500", () => {
    expect(parseAuditLogPayload("cli_invocation", "{not-json")).toBe(null)
  })
  it("returns null on a kind/payload mismatch", () => {
    expect(parseAuditLogPayload("tool_call", JSON.stringify({ subcommand: "send" }))).toBe(null)
  })
  it("returns null on an unknown kind", () => {
    expect(parseAuditLogPayload("shell", JSON.stringify({ name: "bash" }))).toBe(null)
  })
})
