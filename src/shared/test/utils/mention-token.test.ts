import { describe, it, expect } from "vitest"
import { stripMentionTokens, MENTION_TOKEN_RE } from "../../src/utils/mention-token"

describe("stripMentionTokens", () => {
  it("strips a single token to @Name", () => {
    expect(stripMentionTokens("The @[Ada](ag_xk29) will handle it")).toBe("The @Ada will handle it")
  })

  it("strips multiple tokens", () => {
    expect(stripMentionTokens("@[Ada](ag_1) and @[Bob](ag_2)")).toBe("@Ada and @Bob")
  })

  it("mixes tokens with plain text", () => {
    expect(stripMentionTokens("hi @[Ada](ag_1), see you")).toBe("hi @Ada, see you")
  })

  it("leaves a normal markdown link untouched", () => {
    const link = "see [docs](https://example.com/a.b:c)"
    expect(stripMentionTokens(link)).toBe(link)
  })

  it("leaves a plain @Name untouched", () => {
    expect(stripMentionTokens("hey @Ada")).toBe("hey @Ada")
  })

  it("handles empty input", () => {
    expect(stripMentionTokens("")).toBe("")
  })

  it("MENTION_TOKEN_RE does not match a markdown link with url punctuation", () => {
    const re = new RegExp(MENTION_TOKEN_RE.source, "g")
    expect(re.test("[text](https://example.com/path)")).toBe(false)
  })

  it("MENTION_TOKEN_RE matches an ag_ id", () => {
    const re = new RegExp(MENTION_TOKEN_RE.source, "g")
    expect(re.test("@[Ada](ag_xk29AB_-)")).toBe(true)
  })
})
