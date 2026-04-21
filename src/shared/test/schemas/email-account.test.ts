import { describe, it, expect } from "vitest"
import { CreateEmailAccountSchema, UpdateEmailAccountSchema, TestEmailConnectionSchema } from "../../src/schemas"

describe("CreateEmailAccountSchema", () => {
  const valid = {
    emailAddress: "user@gmail.com",
    imapHost: "imap.gmail.com",
    imapUsername: "user@gmail.com",
    imapPassword: "app-password-123",
    smtpHost: "smtp.gmail.com",
    smtpUsername: "user@gmail.com",
    smtpPassword: "app-password-123",
  }

  it("accepts valid input with defaults", () => {
    const result = CreateEmailAccountSchema.parse(valid)
    expect(result.emailAddress).toBe("user@gmail.com")
    expect(result.imapPort).toBe(993)
    expect(result.smtpPort).toBe(587)
    expect(result.imapTls).toBe(true)
    expect(result.smtpTls).toBe(1)
    expect(result.pollIntervalSeconds).toBe(60)
    expect(result.displayName).toBe("")
  })

  it("accepts custom ports", () => {
    const result = CreateEmailAccountSchema.parse({ ...valid, imapPort: 143, smtpPort: 465 })
    expect(result.imapPort).toBe(143)
    expect(result.smtpPort).toBe(465)
  })

  it("rejects invalid email", () => {
    expect(() => CreateEmailAccountSchema.parse({ ...valid, emailAddress: "not-email" })).toThrow()
  })

  it("rejects missing required fields", () => {
    expect(() => CreateEmailAccountSchema.parse({ emailAddress: "u@g.com" })).toThrow()
  })

  it("rejects port out of range", () => {
    expect(() => CreateEmailAccountSchema.parse({ ...valid, imapPort: 0 })).toThrow()
    expect(() => CreateEmailAccountSchema.parse({ ...valid, smtpPort: 70000 })).toThrow()
  })

  it("rejects poll interval too short", () => {
    expect(() => CreateEmailAccountSchema.parse({ ...valid, pollIntervalSeconds: 10 })).toThrow()
  })

  it("rejects poll interval too long", () => {
    expect(() => CreateEmailAccountSchema.parse({ ...valid, pollIntervalSeconds: 7200 })).toThrow()
  })
})

describe("UpdateEmailAccountSchema", () => {
  it("accepts partial update", () => {
    const result = UpdateEmailAccountSchema.parse({ displayName: "New Name" })
    expect(result.displayName).toBe("New Name")
    expect(result.imapHost).toBeUndefined()
  })

  it("accepts empty object", () => {
    const result = UpdateEmailAccountSchema.parse({})
    expect(Object.keys(result).length).toBe(0)
  })

  it("rejects invalid email when provided", () => {
    expect(() => UpdateEmailAccountSchema.parse({ emailAddress: "bad" })).toThrow()
  })
})

describe("TestEmailConnectionSchema", () => {
  const valid = {
    imapHost: "imap.gmail.com",
    imapUsername: "user@gmail.com",
    imapPassword: "pass",
    smtpHost: "smtp.gmail.com",
    smtpUsername: "user@gmail.com",
    smtpPassword: "pass",
  }

  it("accepts valid input", () => {
    const result = TestEmailConnectionSchema.parse(valid)
    expect(result.imapPort).toBe(993)
    expect(result.smtpPort).toBe(587)
  })

  it("rejects missing IMAP host", () => {
    const { imapHost, ...rest } = valid
    expect(() => TestEmailConnectionSchema.parse(rest)).toThrow()
  })
})
