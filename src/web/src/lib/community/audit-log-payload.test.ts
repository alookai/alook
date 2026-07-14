import { describe, it, expect } from "vitest"
import { parseAuditLogPayload } from "./audit-log-payload"

describe("parseAuditLogPayload", () => {
  it("parses a well-shaped cli_invocation payload", () => {
    const p = parseAuditLogPayload("cli_invocation", JSON.stringify({ subcommand: "send" }))
    expect(p).toEqual({ subcommand: "send" })
  })
  it("parses a well-shaped tool_call payload", () => {
    const p = parseAuditLogPayload("tool_call", JSON.stringify({ name: "Read" }))
    expect(p).toEqual({ name: "Read" })
  })
  it("parses a well-shaped thinking payload", () => {
    const p = parseAuditLogPayload(
      "thinking",
      JSON.stringify({ text: "hmm", truncated: false, chars: 3 }),
    )
    expect(p).toEqual({ text: "hmm", truncated: false, chars: 3 })
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
