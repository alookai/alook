import { describe, it, expect } from "vitest"
import { isValidEmail } from "../../src/utils/validation"
describe("isValidEmail", () => {
  it("valid", () => expect(isValidEmail("u@example.com")).toBe(true))
  it("invalid", () => expect(isValidEmail("notanemail")).toBe(false))
})
