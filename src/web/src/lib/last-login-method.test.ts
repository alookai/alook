import { afterEach, describe, expect, it, vi } from "vitest"
import {
  formatLastLoginMethodSetCookie,
  LAST_LOGIN_METHOD_COOKIE,
  LAST_LOGIN_METHOD_MAX_AGE,
  normalizeLoginMethod,
  rememberLastLoginMethod,
  resolveAuthPathLoginMethod,
} from "./last-login-method"

describe("last-login-method helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it("normalizes known providers and email aliases while rejecting unknown values", () => {
    expect(normalizeLoginMethod("github")).toBe("github")
    expect(normalizeLoginMethod("GOOGLE")).toBe("google")
    expect(normalizeLoginMethod(" apple ")).toBe("apple")
    expect(normalizeLoginMethod("email")).toBe("email")
    expect(normalizeLoginMethod("email-otp")).toBe("email")
    expect(normalizeLoginMethod("email_otp")).toBe("email")
    expect(normalizeLoginMethod("")).toBeNull()
    expect(normalizeLoginMethod("discord")).toBeNull()
    expect(normalizeLoginMethod(null)).toBeNull()
    expect(normalizeLoginMethod(undefined)).toBeNull()
  })

  it("resolves Better Auth callback and email endpoints to canonical methods", () => {
    expect(resolveAuthPathLoginMethod("/callback/github")).toBe("github")
    expect(resolveAuthPathLoginMethod("/callback/google")).toBe("google")
    expect(resolveAuthPathLoginMethod("/callback/apple")).toBe("apple")
    expect(resolveAuthPathLoginMethod("/callback/unknown")).toBeNull()
    expect(resolveAuthPathLoginMethod("/sign-in/email")).toBe("email")
    expect(resolveAuthPathLoginMethod("/sign-up/email")).toBe("email")
    expect(resolveAuthPathLoginMethod("/sign-in/email-otp")).toBe("email")
    expect(resolveAuthPathLoginMethod("/one-time-token/verify")).toBeNull()
    expect(resolveAuthPathLoginMethod(null)).toBeNull()
  })

  it("formats a non-better-auth-prefixed cookie string with Lax and optional Secure attributes", () => {
    expect(LAST_LOGIN_METHOD_COOKIE.startsWith("better-auth")).toBe(false)
    expect(formatLastLoginMethodSetCookie("github", false)).toBe(
      `${LAST_LOGIN_METHOD_COOKIE}=github; Max-Age=${LAST_LOGIN_METHOD_MAX_AGE}; Path=/; SameSite=Lax`,
    )
    expect(formatLastLoginMethodSetCookie("apple", true)).toBe(
      `${LAST_LOGIN_METHOD_COOKIE}=apple; Max-Age=${LAST_LOGIN_METHOD_MAX_AGE}; Path=/; SameSite=Lax; Secure`,
    )
  })

  it("no-ops without document and writes insecure or Secure document.cookie based on window protocol", () => {
    vi.stubGlobal("document", undefined)
    expect(() => rememberLastLoginMethod("github")).not.toThrow()

    const cookieDoc = { cookie: "" }
    vi.stubGlobal("document", cookieDoc)
    vi.stubGlobal("window", { location: { protocol: "http:" } })
    rememberLastLoginMethod("google")
    expect(cookieDoc.cookie).toBe(formatLastLoginMethodSetCookie("google", false))

    vi.stubGlobal("window", { location: { protocol: "https:" } })
    rememberLastLoginMethod("email")
    expect(cookieDoc.cookie).toBe(formatLastLoginMethodSetCookie("email", true))

    vi.stubGlobal("window", undefined)
    rememberLastLoginMethod("apple")
    expect(cookieDoc.cookie).toBe(formatLastLoginMethodSetCookie("apple", false))
  })
})
