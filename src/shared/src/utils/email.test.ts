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

  it("catches national government variants via the label rule", () => {
    expect(isSensitiveRecipient("x@libertad.gov.il")).toBe(true)
    expect(isSensitiveRecipient("x@defence.gov.au")).toBe(true)
    expect(isSensitiveRecipient("x@ministere.gouv.fr")).toBe(true)
    expect(isSensitiveRecipient("x@dependencia.gob.mx")).toBe(true)
    expect(isSensitiveRecipient("x@agency.govt.nz")).toBe(true)
    expect(isSensitiveRecipient("x@foo.go.jp")).toBe(true)
    expect(isSensitiveRecipient("x@dept.gc.ca")).toBe(true)
    expect(isSensitiveRecipient("x@army.mil")).toBe(true)
  })

  it("matches on whole labels, not substrings", () => {
    expect(isSensitiveRecipient("x@governance.com")).toBe(false)
    expect(isSensitiveRecipient("x@cargo.io")).toBe(false)
    expect(isSensitiveRecipient("x@mygov.example.com")).toBe(false)
  })

  it("still matches the non-label institution suffixes", () => {
    expect(isSensitiveRecipient("x@ec3.europol.europa.eu")).toBe(true)
    expect(isSensitiveRecipient("cybercrime@interpol.int")).toBe(true)
    expect(isSensitiveRecipient("x@mppe.mp.br")).toBe(true)
  })
})
