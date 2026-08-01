import { describe, it, expect } from "vitest"
import { sanitizeLabel, formatRefToken, parseRefToken } from "./ref-token"

describe("sanitizeLabel", () => {
  it("leaves a plain label untouched", () => {
    expect(sanitizeLabel("/Alook/general")).toBe("/Alook/general")
    expect(sanitizeLabel("/Alook/general#42")).toBe("/Alook/general#42")
  })

  it("collapses a } (the closing delimiter) to _ so it can't break the token", () => {
    // No escape layer (decision B): the label is a display-only fallback, so a
    // `}` in a name is stripped at produce time rather than escaped — escaping
    // collided with markdown's own `\` handling in body text.
    expect(sanitizeLabel("/Alook/plan}b")).toBe("/Alook/plan_b")
  })

  it("collapses each } (no fused words / leftover braces)", () => {
    expect(sanitizeLabel("a}b}c")).toBe("a_b_c")
  })

  it("formatRefToken sanitizes the embedded label so the token always parses", () => {
    const tok = formatRefToken({ label: "/Alook/plan}b", type: "channel", id: "c1" })
    expect(tok).toBe("{/Alook/plan_b}(channel/c1)")
    expect(parseRefToken(tok)).toEqual({ label: "/Alook/plan_b", type: "channel", id: "c1" })
  })
})

describe("formatRefToken / parseRefToken", () => {
  it("formats each type", () => {
    expect(formatRefToken({ label: "/Alook/general", type: "channel", id: "K9f_rnJk" }))
      .toBe("{/Alook/general}(channel/K9f_rnJk)")
    // A message pin is a CHANNEL token whose label carries the `#seq` (ref/id
    // §3.4b — no `message` type; the `()` id is the channelId, seq rides the label).
    expect(formatRefToken({ label: "/Alook/general#42", type: "channel", id: "K9f_rnJk" }))
      .toBe("{/Alook/general#42}(channel/K9f_rnJk)")
    expect(formatRefToken({ label: "/Alook", type: "server", id: "srv_x" }))
      .toBe("{/Alook}(server/srv_x)")
  })

  it("round-trips format → parse for each type", () => {
    for (const t of [
      { label: "/Alook/general", type: "channel" as const, id: "K9f_rnJk" },
      { label: "/Alook/general#42", type: "channel" as const, id: "K9f_rnJk" }, // message pin = channel token + seq-in-label
      { label: "/Alook", type: "server" as const, id: "srv_x" },
    ]) {
      expect(parseRefToken(formatRefToken(t))).toEqual(t)
    }
  })

  it("parses a label carrying / and # (full path, message pin) intact", () => {
    expect(parseRefToken("{/Alook/general#42}(channel/K9f_rnJk)")).toEqual({
      label: "/Alook/general#42",
      type: "channel",
      id: "K9f_rnJk",
    })
  })

  it("a legacy `message` type no longer parses (dropped in §3.4b) — degrades to null", () => {
    expect(parseRefToken("{/Alook/general#42}(message/m_ab)")).toBeNull()
  })

  it("stops the label at the first } (no escape layer) — a raw } is the delimiter", () => {
    // A label with a raw `}` never reaches the parser (the producer sanitizes
    // it via formatRefToken); if one somehow did, `}` closes the label — it is
    // not an escapable character.
    expect(parseRefToken("{/Alook/plan}b}(channel/c1)")).toBeNull()
  })

  it("null on a non-whitelisted type (anti-corruption)", () => {
    expect(parseRefToken("{/x}(user/u_1)")).toBeNull()
    expect(parseRefToken("{/x}(role/r_1)")).toBeNull()
  })

  it("null on a malformed id (outside nanoid charset)", () => {
    expect(parseRefToken("{/x}(channel/has spaces)")).toBeNull()
    expect(parseRefToken("{/x}(channel/has/slash)")).toBeNull()
  })

  it("null on garbage / partial tokens (degrade to plain text, never throw)", () => {
    expect(parseRefToken("just text")).toBeNull()
    expect(parseRefToken("{/x}(channel/")).toBeNull()
    expect(parseRefToken("{/x}channel/c1)")).toBeNull()
    expect(parseRefToken("/Alook/general")).toBeNull() // legacy bare ref is NOT a token
  })

  it("null when a token is only a substring (must be the whole input)", () => {
    expect(parseRefToken("prefix {/x}(channel/c1)")).toBeNull()
    expect(parseRefToken("{/x}(channel/c1) suffix")).toBeNull()
  })
})
