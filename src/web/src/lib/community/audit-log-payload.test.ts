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
  it("parses an empty session_reset payload", () => {
    expect(parseAuditLogPayload("session_reset", JSON.stringify({}))).toEqual({})
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
