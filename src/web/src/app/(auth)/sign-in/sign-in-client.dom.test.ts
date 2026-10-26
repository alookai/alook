import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"

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
vi.mock("./sign-in-fields", async importOriginal => ({
  ...await importOriginal<typeof import("./sign-in-fields")>(),
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
    await user.type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
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
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({ email: "person@example.com", otp: "123456" })
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

  it.each([375, 640].flatMap(width => [true, false].flatMap(isProd => ["", "not-an-email"].map(email => ({ width, isProd, email })))))
  ("at $width with isProd=$isProd, checks consent before validating email '$email' on button clicks", async ({ width, isProd, email }) => {
    window.matchMedia = vi.fn((query: string) => ({ matches: query.includes("max-width") && width < 640, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never
    mocks.devSignIn.mockResolvedValue({ error: { message: "Account not found" } })
    mocks.devSignUp.mockResolvedValue({ error: { message: "Try again" } })
    render(createElement(SignInPageClient, { isProd, appleEnabled: false }))
    const user = setupUser()
    const input = screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement
    const label = isProd ? "Send Code" : "Sign in"
    const request = isProd ? mocks.send : mocks.devSignIn
    const invalidStates: { checked: boolean; dialog: boolean }[] = []
    input.addEventListener("invalid", () => { invalidStates.push({ checked: checkbox.checked, dialog: screen.queryByRole("dialog") !== null }) })
    expect(input).toBeRequired()
    expect(input).toHaveAttribute("type", "email")
    if (email) await user.type(input, email)
    expect(input.validity.valid).toBe(false)
    await user.click(screen.getByRole("button", { name: label }))
    expect(document.getElementById("sign-in-terms-copy")).toHaveClass("text-destructive")
    if (width < 640) {
      expect(screen.getByRole("dialog")).toBeVisible()
      await user.click(screen.getByTestId("sign-in-terms-cancel"))
    }
    expect(invalidStates).toEqual([])
    expect(request).not.toHaveBeenCalled()
    await user.click(checkbox)
    await user.click(checkbox)
    await user.click(screen.getByRole("button", { name: label }))
    expect(document.getElementById("sign-in-terms-copy")).toHaveClass("text-destructive")
    expect(request).not.toHaveBeenCalled()
    if (width < 640) {
      const confirm = screen.getByRole("button", { name: "Agree" })
      await user.click(confirm)
      await act(async () => confirm.click())
    } else {
      await user.click(checkbox)
      await user.click(screen.getByRole("button", { name: label }))
    }
    expect(invalidStates).toEqual([{ checked: true, dialog: false }])
    expect(request).not.toHaveBeenCalled()
    expect(mocks.devSignUp).not.toHaveBeenCalled()
    expect(checkbox).toBeChecked()
    await user.clear(input)
    await user.type(input, "person@example.com")
    await user.click(screen.getByRole("button", { name: label }))
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ email: "person@example.com" }), ...isProd ? [] : [expect.any(Object)])
  })

  it.each([375, 640].flatMap(width => [true, false].map(isProd => ({ width, isProd }))))
  ("at $width with isProd=$isProd, uses the same consent and email validation order on Enter", async ({ width, isProd }) => {
    window.matchMedia = vi.fn((query: string) => ({ matches: query.includes("max-width") && width < 640, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never
    mocks.devSignIn.mockResolvedValue({ error: { message: "Account not found" } })
    mocks.devSignUp.mockResolvedValue({ error: { message: "Try again" } })
    render(createElement(SignInPageClient, { isProd, appleEnabled: false }))
    const user = setupUser()
    const input = screen.getByRole("textbox", { name: "Email" })
    const request = isProd ? mocks.send : mocks.devSignIn
    await user.click(input)
    await user.keyboard("{Enter}")
    expect(document.getElementById("sign-in-terms-copy")).toHaveClass("text-destructive")
    expect(request).not.toHaveBeenCalled()
    if (width < 640) await user.click(screen.getByRole("button", { name: "Agree" }))
    else {
      await user.click(screen.getByRole("checkbox"))
      await user.click(input)
      await user.keyboard("{Enter}")
    }
    expect(request).not.toHaveBeenCalled()
    expect(input).toBeInvalid()
    await user.type(input, "person@example.com{Enter}")
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([true, false])("with isProd=%s, submits the email validated after the dialog finishes closing", async isProd => {
    window.matchMedia = vi.fn((query: string) => ({ matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never
    mocks.devSignIn.mockResolvedValue({ error: { message: "Account not found" } })
    mocks.devSignUp.mockResolvedValue({ error: { message: "Try again" } })
    render(createElement(SignInPageClient, { isProd, appleEnabled: false }))
    const user = setupUser()
    const input = screen.getByRole("textbox", { name: "Email" })
    const request = isProd ? mocks.send : mocks.devSignIn
    await user.type(input, "old@example.com")
    await user.click(screen.getByRole("button", { name: isProd ? "Send Code" : "Sign in" }))
    const popup = screen.getByRole("dialog")
    let finish!: () => void
    const finished = new Promise<void>(resolve => { finish = resolve })
    const getAnimations = vi.fn(() => [{ finished }])
    Object.defineProperty(popup, "getAnimations", { value: getAnimations })
    await user.click(screen.getByRole("button", { name: "Agree" }))
    await waitFor(() => expect(getAnimations).toHaveBeenCalled())
    expect(request).not.toHaveBeenCalled()
    await user.clear(input)
    await user.type(input, "person@example.com")
    await act(async () => { finish(); await finished })
    await waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({ email: "person@example.com" }))
  })

  it.each([true, false].flatMap(isProd => ["", "not-an-email"].flatMap(email => ["button", "enter"].map(submission => ({ isProd, email, submission })))))("with isProd=$isProd, email='$email' and $submission, preserves native invalid-email focus after the mobile dialog closes", async ({ isProd, email, submission }) => {
    window.matchMedia = vi.fn((query: string) => ({ matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never
    render(createElement(SignInPageClient, { isProd, appleEnabled: false }))
    const user = setupUser()
    const input = screen.getByRole("textbox", { name: "Email" })
    const invalid = vi.fn(() => input.focus())
    input.addEventListener("invalid", invalid)
    if (email) await user.type(input, email)
    if (submission === "button") {
      await user.click(screen.getByRole("button", { name: isProd ? "Send Code" : "Sign in" }))
    } else {
      await user.click(input)
      await user.keyboard("{Enter}")
    }
    await user.click(screen.getByRole("button", { name: "Agree" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await act(async () => { await Promise.resolve() })
    expect(invalid).toHaveBeenCalledOnce()
    expect(input).toHaveFocus()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.devSignIn).not.toHaveBeenCalled()
  })

  it("counts login entry once and records only bounded OTP failure dimensions", async () => {
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    expect(mocks.capture).toHaveBeenCalledWith({ event: "login_page_view" })
    await setupUser().type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
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
    await setupUser().type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
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
    await setupUser().type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
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
