import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { SignInEmailField, SignInOtpField } from "./sign-in-fields"

describe("sign-in field errors", () => {
  it("renders an email error once after its input and links the input to it", () => {
    const html = renderToStaticMarkup(createElement(SignInEmailField, {
      email: "person@example.com",
      error: "Failed to send code",
      onChange: vi.fn(),
    }))

    expect(html.match(/Failed to send code/g)).toHaveLength(1)
    expect(html.indexOf('id="email"')).toBeLessThan(html.indexOf('id="sign-in-email-error"'))
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="sign-in-email-error"')
  })

  it("renders an OTP error once after the six slots and links the OTP input to it", () => {
    const html = renderToStaticMarkup(createElement(SignInOtpField, {
      code: "",
      error: "Invalid OTP",
      loading: false,
      onChange: vi.fn(),
    }))

    expect(html.match(/data-slot="input-otp-slot"/g)).toHaveLength(6)
    expect(html.match(/Invalid OTP/g)).toHaveLength(1)
    expect(html.lastIndexOf('data-slot="input-otp-slot"')).toBeLessThan(
      html.indexOf('id="sign-in-otp-error"'),
    )
    expect(html).toContain('aria-label="Verification code"')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="sign-in-otp-error"')
    expect(html).toContain("text-center")
  })

  it("does not reserve or link an alert when a field has no error", () => {
    const email = renderToStaticMarkup(createElement(SignInEmailField, {
      email: "",
      onChange: vi.fn(),
    }))
    const otp = renderToStaticMarkup(createElement(SignInOtpField, {
      code: "",
      loading: false,
      onChange: vi.fn(),
    }))

    expect(email).not.toContain('role="alert"')
    expect(email).not.toContain("aria-describedby")
    expect(otp).not.toContain('role="alert"')
    expect(otp).not.toContain("aria-describedby")
  })
})
