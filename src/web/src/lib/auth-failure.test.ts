import { describe, expect, it } from "vitest"
import { authFailureParams } from "./auth-failure"

describe("authentication failure details", () => {
  it.each([
    ["PROVIDER_NOT_FOUND", "Provider not found", 404],
    ["INVALID_ORIGIN", "Invalid origin", 403],
    ["INVALID_OTP", "Invalid OTP", 400],
    ["OTP_EXPIRED", "OTP expired", 400],
    ["TOO_MANY_ATTEMPTS", "Too many attempts", 403],
  ])("keeps the returned %s cause without forwarding arbitrary messages", (code, reason, status) => {
    expect(authFailureParams({ code, status, message: "private@example.test token=secret otp=123456" }))
      .toEqual({ error_code: code, error_reason: reason, http_status: String(status) })
  })

  it("records rate limiting even when the response has no authentication code", () => {
    expect(authFailureParams({ status: 429, message: "private response" }))
      .toEqual({ error_code: "RATE_LIMIT_EXCEEDED", error_reason: "Too many requests", http_status: "429" })
  })

  it.each(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."])("recognizes browser fetch rejection: %s", message => {
    expect(authFailureParams(new TypeError(message)))
      .toEqual({ error_code: "NETWORK_ERROR", error_reason: "Network request failed" })
  })

  it("does not claim an unknown HTTP error's root cause", () => {
    expect(authFailureParams({ code: "TOKEN_SECRET", message: "https://host/?code=secret", status: 503 }))
      .toEqual({ error_code: "HTTP_ERROR", error_reason: "HTTP 503", http_status: "503" })
  })

  it.each([null, "private@example.test", new Error("token=secret"), { code: "__proto__", status: 999 }])("handles an unrecognized error without leaking its contents", error => {
    expect(authFailureParams(error))
      .toEqual({ error_code: "UNKNOWN_ERROR", error_reason: "No recognized error detail returned" })
  })
})
