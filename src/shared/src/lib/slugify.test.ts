import { describe, it, expect } from "vitest"
import { slugify } from "./slugify"

describe("slugify", () => {
  it("replaces whitespace with a hyphen", () => {
    expect(slugify("My Home")).toBe("My-Home")
  })

  it("preserves case — does not lowercase", () => {
    expect(slugify("General Chat")).toBe("General-Chat")
  })

  it("preserves non-Latin scripts and emoji", () => {
    expect(slugify("𝔄𝔅 🎉")).toBe("𝔄𝔅-🎉")
  })

  it("strips / and # outright, with no hyphen substitution", () => {
    expect(slugify("a/b#c")).toBe("abc")
  })

  it("collapses repeated whitespace/hyphens into a single hyphen", () => {
    expect(slugify("My   -  Home")).toBe("My-Home")
  })

  it("trims leading/trailing whitespace and hyphens", () => {
    expect(slugify("  -foo-  ")).toBe("foo")
  })

  it("normalizes an all-disallowed-chars input to an empty string", () => {
    expect(slugify("   ")).toBe("")
    expect(slugify("###")).toBe("")
    expect(slugify("/")).toBe("")
  })

  it("leaves an already-clean input unchanged", () => {
    expect(slugify("general")).toBe("general")
  })

  it("preserves punctuation other than the reserved characters", () => {
    expect(slugify("My thoughts on this!")).toBe("My-thoughts-on-this!")
  })
})
