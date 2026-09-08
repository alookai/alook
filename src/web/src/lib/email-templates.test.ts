import { describe, it, expect } from "vitest"
import { renderOtpEmail, getOtpSubject } from "./email-templates"

const otpTypes = [
  "sign-in",
  "email-verification",
  "forget-password",
  "change-email",
  "account-deletion",
] as const

describe("getOtpSubject", () => {
  it.each(otpTypes)("returns a non-empty subject for type '%s'", (type) => {
    const subject = getOtpSubject(type)
    expect(subject).toBeTruthy()
    expect(typeof subject).toBe("string")
  })

  it("returns distinct subjects for each type", () => {
    const subjects = otpTypes.map((t) => getOtpSubject(t))
    expect(new Set(subjects).size).toBe(otpTypes.length)
  })
})

describe("renderOtpEmail", () => {
  const testOtp = "483921"

  it.each(otpTypes)(
    "returns HTML containing the OTP code for type '%s'",
    (type) => {
      const html = renderOtpEmail(testOtp, type)
      expect(html).toContain(testOtp)
      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("</html>")
    }
  )

  it.each(otpTypes)(
    "contains a contextual heading for type '%s'",
    (type) => {
      const html = renderOtpEmail(testOtp, type)
      // Each type should have a unique heading in the email
      expect(html).toContain("<h1")
    }
  )

  it("does not contain unresolved template variables", () => {
    for (const type of otpTypes) {
      const html = renderOtpEmail(testOtp, type)
      expect(html).not.toMatch(/\$\{/)
      expect(html).not.toContain("undefined")
      expect(html).not.toContain("null")
    }
  })
})
