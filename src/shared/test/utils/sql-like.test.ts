import { describe, it, expect } from "vitest"
import { escapeLikePattern } from "../../src/utils/sql-like"

describe("escapeLikePattern", () => {
  it("leaves plain text untouched", () => {
    expect(escapeLikePattern("alice")).toBe("alice")
  })

  it("escapes the % wildcard so it matches a literal %", () => {
    // Without escaping, `%` matches any sequence in SQL LIKE.
    expect(escapeLikePattern("50%")).toBe("50\\%")
  })

  it("escapes the _ wildcard so it matches a literal _", () => {
    expect(escapeLikePattern("foo_bar")).toBe("foo\\_bar")
  })

  it("escapes backslash itself so the escape clause is consistent", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b")
  })

  it("handles a mix of wildcards and plain chars", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d")
  })

  it("returns empty string for empty input", () => {
    expect(escapeLikePattern("")).toBe("")
  })
})
