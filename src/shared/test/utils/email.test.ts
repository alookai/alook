import { describe, it, expect } from "vitest"
import { parseEmailHandle, toAlookAddress, isValidHandle } from "../../src/utils/email"
describe("parseEmailHandle", () => {
  it("extracts handle", () => expect(parseEmailHandle("jarvis@alook.ai")).toBe("jarvis"))
  it("empty for non-alook", () => expect(parseEmailHandle("u@gmail.com")).toBe(""))
})
describe("toAlookAddress", () => { it("appends domain", () => expect(toAlookAddress("jarvis")).toBe("jarvis@alook.ai")) })
describe("isValidHandle", () => {
  it("accepts 3+ alphanum+dash", () => { expect(isValidHandle("jarvis")).toBe(true); expect(isValidHandle("my-bot")).toBe(true); expect(isValidHandle("abc")).toBe(true) })
  it("rejects <3", () => expect(isValidHandle("ab")).toBe(false))
  it("rejects spaces/underscores", () => { expect(isValidHandle("my agent")).toBe(false); expect(isValidHandle("my_bot")).toBe(false) })
  it("rejects reserved handles", () => {
    expect(isValidHandle("no-reply")).toBe(false)
    expect(isValidHandle("noreply")).toBe(false)
    expect(isValidHandle("admin")).toBe(false)
    expect(isValidHandle("support")).toBe(false)
    expect(isValidHandle("postmaster")).toBe(false)
    expect(isValidHandle("abuse")).toBe(false)
    expect(isValidHandle("alook")).toBe(false)
  })
  it("rejects reserved handles case-insensitively", () => {
    expect(isValidHandle("No-Reply")).toBe(false)
    expect(isValidHandle("ADMIN")).toBe(false)
  })
})
