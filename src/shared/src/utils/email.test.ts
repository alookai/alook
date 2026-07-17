import { describe, it, expect } from "vitest"
import { extractDomain, isSensitiveRecipient } from "./email"

describe("extractDomain", () => {
  it("returns the domain of a normal address", () => {
    expect(extractDomain("a@b.com")).toBe("b.com")
  })

  it("returns the domain from a display-name form", () => {
    expect(extractDomain("Foo <a@b.com>")).toBe("b.com")
  })

  it("lowercases the domain", () => {
    expect(extractDomain("a@B.COM")).toBe("b.com")
  })

  it("returns null for no-@ input", () => {
    expect(extractDomain("not-an-email")).toBeNull()
  })

  it("returns null for empty input", () => {
    expect(extractDomain("")).toBeNull()
  })
})

describe("isSensitiveRecipient", () => {
  it("matches an exact domain", () => {
    expect(isSensitiveRecipient("x@nca.gov.uk")).toBe(true)
  })

  it("matches by suffix (.gov.br)", () => {
    expect(isSensitiveRecipient("x@policiacivil.pe.gov.br")).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(isSensitiveRecipient("X@PF.GOV.BR")).toBe(true)
  })

  it("passes a normal external domain", () => {
    expect(isSensitiveRecipient("x@example.com")).toBe(false)
  })

  it("does not match the internal @alook.ai domain", () => {
    expect(isSensitiveRecipient("x@alook.ai")).toBe(false)
  })

  it("returns false for a malformed address without throwing", () => {
    expect(isSensitiveRecipient("garbage")).toBe(false)
    expect(isSensitiveRecipient("")).toBe(false)
  })

  it("does not let a display-name wrapper bypass the filter", () => {
    expect(isSensitiveRecipient("Government <x@pf.gov.br>")).toBe(true)
  })
})
