import { describe, it, expect } from "vitest"
import { avatarInitial } from "./avatar"

describe("avatarInitial", () => {
  it("returns uppercased first character of a name", () => {
    expect(avatarInitial("alice")).toBe("A")
  })

  it("returns '?' for whitespace-only input (safety net)", () => {
    // Should never fire post-migration 0050, but the helper still guards it.
    expect(avatarInitial("  ")).toBe("?")
  })

  it("returns '?' for empty string", () => {
    expect(avatarInitial("")).toBe("?")
  })

  it("uppercases lowercase letters", () => {
    expect(avatarInitial("bob")).toBe("B")
  })

  it("preserves non-latin uppercase first character", () => {
    expect(avatarInitial("Ünsal")).toBe("Ü")
  })

  it("trims leading whitespace before taking the first character", () => {
    expect(avatarInitial("  alice")).toBe("A")
  })
})
