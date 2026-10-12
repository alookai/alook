import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, setupUser } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  capture: vi.fn(),
  send: vi.fn(),
  verify: vi.fn(),
  verifyInput: undefined as undefined | ((value: string) => Promise<void>),
}))

vi.mock("@/lib/product-analytics", () => ({ captureProductAnalytics: mocks.capture }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: { emailOtp: { sendVerificationOtp: mocks.send }, signIn: { emailOtp: mocks.verify } },
  signIn: {},
  signUp: {},
}))
vi.mock("./sign-in-fields", () => ({
  SignInEmailField: () => null,
  SignInOtpField: ({ onChange }: { onChange: (value: string) => Promise<void> }) => { mocks.verifyInput = onChange; return null },
}))
vi.mock("./social-sign-in", () => ({
  SocialSignIn: ({
    postLoginUrl,
    appleEnabled,
  }: {
    postLoginUrl: string
    appleEnabled: boolean
  }) => createElement("div", {
    "data-testid": "social-sign-in-props",
    "data-post-login-url": postLoginUrl,
    "data-apple-enabled": String(appleEnabled),
  }),
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
    vi.clearAllMocks(); mocks.send.mockResolvedValue({}); mocks.verify.mockResolvedValue({ error: { message: "bad code" } }); mocks.verifyInput = undefined
    mocks.searchParams = new URLSearchParams("redirect=%2Fc%2Fme")
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as never
  })

  it("counts login entry once and records only bounded OTP failure dimensions", async () => {
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    expect(mocks.capture).toHaveBeenCalledWith({ event: "login_page_view" }, expect.any(String))
    await setupUser().click(screen.getByRole("button", { name: "Send Code" }))
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    await act(async () => { await mocks.verifyInput!("123456") })
    expect(mocks.capture).toHaveBeenLastCalledWith({ event: "sign_in_failed", method: "email_otp", failureStage: "verify_code" })
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("123456")
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("bad code")
  })

  it("records send-code failure without mistaking it for successful authentication", async () => {
    mocks.send.mockResolvedValueOnce({ error: { message: "private detail" } })
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    await setupUser().click(screen.getByRole("button", { name: "Send Code" }))
    expect(mocks.capture).toHaveBeenLastCalledWith({ event: "sign_in_failed", method: "email_otp", failureStage: "send_code" })
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("private detail")
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("sign_in_success")
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
