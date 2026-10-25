import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, setupUser } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  capture: vi.fn(),
  send: vi.fn(),
  verify: vi.fn(),
  devSignIn: vi.fn(),
  devSignUp: vi.fn(),
  verifyInput: undefined as undefined | ((value: string) => Promise<void>),
  socialGate: undefined as undefined | ((continuation: () => void) => void),
}))

vi.mock("@/lib/product-analytics", () => ({ captureProductAnalytics: mocks.capture }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: { emailOtp: { sendVerificationOtp: mocks.send }, signIn: { emailOtp: mocks.verify } },
  signIn: { email: mocks.devSignIn },
  signUp: { email: mocks.devSignUp },
}))
vi.mock("./sign-in-fields", () => ({
  SignInEmailField: ({ email, onChange }: { email: string; onChange: (event: { target: { value: string } }) => void }) => createElement("input", { type: "email", "aria-label": "Email", value: email, onChange }),
  SignInOtpField: ({ onChange }: { onChange: (value: string) => Promise<void> }) => { mocks.verifyInput = onChange; return null },
}))
vi.mock("./social-sign-in", () => ({
  SocialSignIn: ({
    postLoginUrl,
    appleEnabled,
    requestConsent,
  }: {
    postLoginUrl: string
    appleEnabled: boolean
    requestConsent: (continuation: () => void) => void
  }) => { mocks.socialGate = requestConsent; return createElement("div", {
    "data-testid": "social-sign-in-props",
    "data-post-login-url": postLoginUrl,
    "data-apple-enabled": String(appleEnabled),
  }) },
}))
vi.mock("@/components/gradient-background", () => ({
  GradientBackground: () => null,
}))
vi.mock("@/components/logo", () => ({
  Logo: () => null,
}))
vi.mock("@/components/home/landing-shell-motion", () => ({
  LandingShellMotion: () => null,
}))
vi.mock("@/components/home/landing-shell-motion.module.css", () => ({
  default: {},
}))

import SignInPageClient from "./sign-in-client"

describe("sign-in client Apple availability", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.send.mockResolvedValue({}); mocks.verify.mockResolvedValue({ error: { code: "INVALID_OTP", status: 400 } }); mocks.verifyInput = undefined; mocks.socialGate = undefined
    mocks.searchParams = new URLSearchParams("redirect=%2Fc%2Fme")
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as never
  })

  it("does not claim removal is complete while deletion remains pending", () => {
    mocks.searchParams = new URLSearchParams("account_deleted=pending")
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    expect(screen.getByRole("status")).toHaveTextContent("Account deletion requested")
    expect(screen.getByRole("status")).toHaveTextContent("Cleanup will retry automatically")
    expect(screen.queryByText("Your account and its data were removed.")).toBeNull()
  })

  it("holds email, verification and the passed social continuation behind the same agreement", async () => {
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: true }))
    const user = setupUser()
    await user.click(screen.getByRole("button", { name: "Send Code" }))
    expect(mocks.send).not.toHaveBeenCalled()
    const social = vi.fn()
    await act(async () => mocks.socialGate!(social))
    expect(social).not.toHaveBeenCalled()
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Send Code" }))
    expect(mocks.send).toHaveBeenCalledOnce()
    await act(async () => mocks.socialGate!(social))
    expect(social).toHaveBeenCalledOnce()
    await user.click(screen.getByRole("checkbox"))
    await act(async () => { await mocks.verifyInput!("123456") })
    expect(mocks.verify).not.toHaveBeenCalled()
    await user.click(screen.getByRole("checkbox"))
    await act(async () => { await mocks.verifyInput!("123456") })
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({ email: "", otp: "123456" })
  })

  it("mobile confirmation starts email once and keeps the existing OTP error flow", async () => {
    window.matchMedia = vi.fn((query: string) => ({ matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    const user = setupUser()
    await user.type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
    await user.click(screen.getByRole("button", { name: "Send Code" }))
    expect(mocks.send).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("sign-in-terms-cancel"))
    expect(mocks.send).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue("person@example.com")
    await user.click(screen.getByRole("button", { name: "Send Code" }))
    await user.click(screen.getByTestId("sign-in-terms-confirm"))
    expect(mocks.send).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ email: "person@example.com", type: "sign-in" }))
    expect(screen.getByRole("checkbox")).toBeChecked()
    await act(async () => { await mocks.verifyInput!("123456") })
    expect(mocks.verify).toHaveBeenCalledOnce()
    expect(mocks.capture).toHaveBeenLastCalledWith(expect.objectContaining({ failureStage: "verify_code" }))
  })

  it("guards development login and preserves its signup fallback after agreement", async () => {
    mocks.devSignIn.mockResolvedValue({ error: { message: "Account not found" } })
    mocks.devSignUp.mockResolvedValue({ error: { message: "Try again" } })
    render(createElement(SignInPageClient, { isProd: false, appleEnabled: false }))
    const user = setupUser()
    await user.type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
    await user.click(screen.getByRole("button", { name: "Sign in", exact: true }))
    expect(mocks.devSignIn).not.toHaveBeenCalled()
    expect(mocks.devSignUp).not.toHaveBeenCalled()
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Sign in", exact: true }))
    expect(mocks.devSignIn).toHaveBeenCalledOnce()
    expect(mocks.devSignUp).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ email: "person@example.com", name: "person" }), expect.any(Object))
    expect(screen.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled()
  })

  it("counts login entry once and records only bounded OTP failure dimensions", async () => {
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    expect(mocks.capture).toHaveBeenCalledWith({ event: "login_page_view" })
    await setupUser().click(screen.getByRole("checkbox"))
    await setupUser().click(screen.getByRole("button", { name: "Send Code" }))
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    await act(async () => { await mocks.verifyInput!("123456") })
    expect(mocks.capture).toHaveBeenLastCalledWith({ event: "sign_in_failed", method: "email_otp", failureStage: "verify_code", error: { code: "INVALID_OTP", status: 400 } })
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("123456")
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("bad code")
  })

  it("records send-code failure without mistaking it for successful authentication", async () => {
    mocks.send.mockResolvedValueOnce({ error: { status: 429 } })
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    await setupUser().click(screen.getByRole("checkbox"))
    await setupUser().click(screen.getByRole("button", { name: "Send Code" }))
    expect(mocks.capture).toHaveBeenLastCalledWith({ event: "sign_in_failed", method: "email_otp", failureStage: "send_code", error: { status: 429 } })
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("private detail")
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("sign_in_success")
  })

  it("forwards caught send and verification failures with their actual stage", async () => {
    const error = new TypeError("Failed to fetch")
    mocks.send.mockRejectedValueOnce(error)
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    await setupUser().click(screen.getByRole("checkbox"))
    await setupUser().click(screen.getByRole("button", { name: "Send Code" }))
    expect(mocks.capture).toHaveBeenLastCalledWith({ event: "sign_in_failed", method: "email_otp", failureStage: "send_code", error })
    await setupUser().click(screen.getByRole("button", { name: "Send Code" }))
    mocks.verify.mockRejectedValueOnce(error)
    await act(async () => { await mocks.verifyInput!("123456") })
    expect(mocks.capture).toHaveBeenLastCalledWith({ event: "sign_in_failed", method: "email_otp", failureStage: "verify_code", error })
  })

  it.each([true, false])("passes server-derived appleEnabled=%s unchanged", (appleEnabled) => {
    render(createElement(SignInPageClient, { isProd: true, appleEnabled }))

    const social = screen.getByTestId("social-sign-in-props")
    expect(social).toHaveAttribute("data-post-login-url", "/c/me")
    expect(social).toHaveAttribute("data-apple-enabled", String(appleEnabled))
  })

  it.each([
    [true, "Send Code"],
    [false, "Sign in"],
  ] as const)("uses the former social outline style for the email action when isProd=%s", (isProd, label) => {
    render(createElement(SignInPageClient, { isProd, appleEnabled: true }))

    expect(screen.getByRole("button", { name: label })).toHaveClass(
      "h-9",
      "border-border",
      "bg-background",
      "text-base",
      "w-full",
    )
  })
})
