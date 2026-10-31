import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, setupUser } from "@/test/react-dom-harness"
import type { LoginMethod } from "@/lib/last-login-method"

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  capture: vi.fn(),
  send: vi.fn(),
  verify: vi.fn(),
  devSignIn: vi.fn(),
  devSignUp: vi.fn(),
  getLastUsedLoginMethod: vi.fn<() => string | null>(() => null),
  rememberLastLoginMethod: vi.fn(),
  verifyInput: undefined as undefined | ((value: string) => Promise<void>),
  selectSocial: undefined as undefined | ((method: "github" | "google" | "apple") => void),
}))

vi.mock("@/lib/product-analytics", () => ({ captureProductAnalytics: mocks.capture }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    emailOtp: { sendVerificationOtp: mocks.send },
    signIn: { emailOtp: mocks.verify },
    getLastUsedLoginMethod: mocks.getLastUsedLoginMethod,
  },
  signIn: { email: mocks.devSignIn },
  signUp: { email: mocks.devSignUp },
}))
vi.mock("@/lib/last-login-method", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/last-login-method")>()),
  rememberLastLoginMethod: mocks.rememberLastLoginMethod,
}))
vi.mock("./sign-in-fields", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sign-in-fields")>()),
  SignInOtpField: ({
    autoFocus = true,
    onChange,
  }: {
    autoFocus?: boolean
    onChange: (value: string) => Promise<void>
  }) => {
    mocks.verifyInput = onChange
    return createElement("input", {
      "aria-label": "Verification code",
      "data-testid": "otp-field-stub",
      "data-autofocus": String(autoFocus),
    })
  },
}))
vi.mock("./social-sign-in", () => ({
  SocialSignIn: ({
    postLoginUrl,
    appleEnabled,
    lastUsedMethod,
    onSelectMethod,
  }: {
    postLoginUrl: string
    appleEnabled: boolean
    lastUsedMethod?: LoginMethod | null
    onSelectMethod?: (method: "github" | "google" | "apple") => void
  }) => {
    mocks.selectSocial = onSelectMethod
    return createElement("div", {
      "data-testid": "social-sign-in-props",
      "data-post-login-url": postLoginUrl,
      "data-apple-enabled": String(appleEnabled),
      "data-last-used": lastUsedMethod ?? "",
    })
  },
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
vi.mock("@/components/typewriter-visual", () => ({
  TypewriterVisual: () => createElement("div", { "data-testid": "mobile-typewriter-stub" }),
}))

import SignInPageClient from "./sign-in-client"

describe("sign-in client layout, consent-on-continue, and last-used method", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.send.mockResolvedValue({})
    mocks.verify.mockResolvedValue({ error: { code: "INVALID_OTP", status: 400 } })
    mocks.getLastUsedLoginMethod.mockReturnValue(null)
    mocks.verifyInput = undefined
    mocks.selectSocial = undefined
    mocks.searchParams = new URLSearchParams("redirect=%2Fc%2Fme")
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as never
  })

  it("places social quick-sign-in above the separator, email form, and passive terms footer without auto-focusing email", () => {
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: true }))

    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()

    const heading = screen.getByRole("heading", { name: /Welcome to\s+Alook/i })
    expect(heading).toHaveClass("whitespace-nowrap")
    expect(heading.querySelector('img[src="/alook.svg"]')).not.toBeNull()

    const social = screen.getByTestId("social-sign-in-props")
    const emailInput = screen.getByRole("textbox", { name: "Email" })
    const emailButton = screen.getByRole("button", { name: "Continue with email" })
    const terms = screen.getByTestId("sign-in-terms")

    expect(emailInput).not.toHaveFocus()
    expect(
      social.compareDocumentPosition(emailInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      emailInput.compareDocumentPosition(emailButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      emailButton.compareDocumentPosition(terms) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("does not claim removal is complete while deletion remains pending", () => {
    mocks.searchParams = new URLSearchParams("account_deleted=pending")
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    expect(screen.getByRole("status")).toHaveTextContent("Account deletion requested")
    expect(screen.getByRole("status")).toHaveTextContent("Cleanup will retry automatically")
    expect(screen.queryByText("Your account and its data were removed.")).toBeNull()
  })

  it("sends OTP and verifies code immediately without requiring a checkbox or modal, then allows switching email", async () => {
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: true }))
    const user = setupUser()

    await user.type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
    await user.click(screen.getByRole("button", { name: "Continue with email" }))

    expect(mocks.send).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ email: "person@example.com", type: "sign-in" }),
    )
    expect(mocks.rememberLastLoginMethod).toHaveBeenCalledWith("email")
    expect(screen.queryByTestId("social-sign-in-props")).toBeNull()
    expect(screen.getByRole("heading", { name: "Check your email" })).toBeVisible()

    await act(async () => {
      await mocks.verifyInput!("123456")
    })
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({
      email: "person@example.com",
      otp: "123456",
    })

    await user.click(screen.getByRole("button", { name: "Use a different email" }))
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue("person@example.com")
    expect(screen.getByTestId("last-used-email")).toHaveTextContent("Last used")
  })

  it("preserves development sign-in and signup fallback immediately on submit", async () => {
    mocks.devSignIn.mockResolvedValue({ error: { message: "Account not found" } })
    mocks.devSignUp.mockResolvedValue({ error: { message: "Try again" } })
    render(createElement(SignInPageClient, { isProd: false, appleEnabled: false }))
    const user = setupUser()

    await user.type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
    await user.click(screen.getByRole("button", { name: "Sign in", exact: true }))

    expect(mocks.devSignIn).toHaveBeenCalledOnce()
    expect(mocks.devSignUp).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ email: "person@example.com", name: "person" }),
      expect.any(Object),
    )
    expect(mocks.rememberLastLoginMethod).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled()
  })

  it.each(
    [true, false].flatMap((isProd) =>
      ["", "not-an-email"].map((email) => ({ isProd, email })),
    ),
  )(
    "with isProd=$isProd, validates '$email' natively before sending",
    async ({ isProd, email }) => {
      render(createElement(SignInPageClient, { isProd, appleEnabled: false }))
      const user = setupUser()
      const input = screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement
      const label = isProd ? "Continue with email" : "Sign in"
      const request = isProd ? mocks.send : mocks.devSignIn
      const onInvalid = vi.fn()
      input.addEventListener("invalid", onInvalid)

      expect(input).toBeRequired()
      expect(input).toHaveAttribute("type", "email")
      if (email) await user.type(input, email)
      await user.click(screen.getByRole("button", { name: label, exact: true }))

      expect(onInvalid).toHaveBeenCalledOnce()
      expect(request).not.toHaveBeenCalled()
    },
  )

  it("renders Last used from SSR prop or client cookie and keeps exact button accessible names intact", () => {
    const first = render(
      createElement(SignInPageClient, {
        isProd: true,
        appleEnabled: true,
        initialLastUsedMethod: "email",
      }),
    )
    const emailButton = screen.getByRole("button", {
      name: "Continue with email",
      exact: true,
    })
    expect(emailButton).toHaveAttribute("aria-describedby", "last-used-email-badge")
    expect(screen.getByTestId("last-used-email")).toHaveTextContent("Last used")
    first.unmount()

    mocks.getLastUsedLoginMethod.mockReturnValue("github")
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: true }))
    expect(screen.getByTestId("social-sign-in-props")).toHaveAttribute(
      "data-last-used",
      "github",
    )

    act(() => {
      mocks.selectSocial?.("apple")
    })
    expect(screen.getByTestId("social-sign-in-props")).toHaveAttribute(
      "data-last-used",
      "apple",
    )
  })

  it("counts login entry once and records only bounded OTP failure dimensions", async () => {
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    expect(mocks.capture).toHaveBeenCalledWith({ event: "login_page_view" })
    await setupUser().type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
    await setupUser().click(screen.getByRole("button", { name: "Continue with email" }))
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    await act(async () => {
      await mocks.verifyInput!("123456")
    })
    expect(mocks.capture).toHaveBeenLastCalledWith({
      event: "sign_in_failed",
      method: "email_otp",
      failureStage: "verify_code",
      error: { code: "INVALID_OTP", status: 400 },
    })
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("123456")
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("bad code")
  })

  it("records send-code failure without mistaking it for successful authentication", async () => {
    mocks.send.mockResolvedValueOnce({ error: { status: 429 } })
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    await setupUser().type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
    await setupUser().click(screen.getByRole("button", { name: "Continue with email" }))
    expect(mocks.capture).toHaveBeenLastCalledWith({
      event: "sign_in_failed",
      method: "email_otp",
      failureStage: "send_code",
      error: { status: 429 },
    })
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("private detail")
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("sign_in_success")
  })

  it("forwards caught send and verification failures with their actual stage", async () => {
    const error = new TypeError("Failed to fetch")
    mocks.send.mockRejectedValueOnce(error)
    render(createElement(SignInPageClient, { isProd: true, appleEnabled: false }))
    await setupUser().type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
    await setupUser().click(screen.getByRole("button", { name: "Continue with email" }))
    expect(mocks.capture).toHaveBeenLastCalledWith({
      event: "sign_in_failed",
      method: "email_otp",
      failureStage: "send_code",
      error,
    })
    await setupUser().click(screen.getByRole("button", { name: "Continue with email" }))
    mocks.verify.mockRejectedValueOnce(error)
    await act(async () => {
      await mocks.verifyInput!("123456")
    })
    expect(mocks.capture).toHaveBeenLastCalledWith({
      event: "sign_in_failed",
      method: "email_otp",
      failureStage: "verify_code",
      error,
    })
  })

  it.each([true, false])("passes server-derived appleEnabled=%s unchanged", (appleEnabled) => {
    render(createElement(SignInPageClient, { isProd: true, appleEnabled }))

    const social = screen.getByTestId("social-sign-in-props")
    expect(social).toHaveAttribute("data-post-login-url", "/c/me")
    expect(social).toHaveAttribute("data-apple-enabled", String(appleEnabled))
  })

  it.each([
    [true, "Continue with email"],
    [false, "Sign in"],
  ] as const)(
    "uses the outline secondary style and 44px touch target for the email action when isProd=%s",
    (isProd, label) => {
      render(createElement(SignInPageClient, { isProd, appleEnabled: true }))

      const button = screen.getByRole("button", { name: label, exact: true })
      expect(button).toHaveClass(
        "h-11",
        "justify-start",
        "border-border",
        "bg-background",
        "w-full",
      )
      expect(button.querySelector("svg")).not.toBeNull()
    },
  )

  it("renders the borderless mobile typewriter above login and collapses it when the viewport shrinks for keyboard or short screens", () => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes("max-width"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as never
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 })

    render(createElement(SignInPageClient, { isProd: true, appleEnabled: true }))
    const stage = screen.getByTestId("sign-in-mobile-typewriter")
    expect(stage).toHaveAttribute("data-collapsed", "false")
    expect(screen.getByTestId("mobile-typewriter-stub")).toBeVisible()

    act(() => {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 460 })
      window.dispatchEvent(new Event("resize"))
    })
    expect(stage).toHaveAttribute("data-collapsed", "true")
    expect(screen.queryByTestId("mobile-typewriter-stub")).toBeNull()
  })

  it("slides the mobile typewriter and login pane left into a pure centered OTP pane and focuses the OTP input on completion", async () => {
    const rafQueue: FrameRequestCallback[] = []
    const origRaf = window.requestAnimationFrame
    const origCancelRaf = window.cancelAnimationFrame
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    }) as typeof window.requestAnimationFrame
    window.cancelAnimationFrame = vi.fn()
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes("max-width"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as never
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 })

    try {
      render(createElement(SignInPageClient, { isProd: true, appleEnabled: true }))
      const user = setupUser()

      await user.type(screen.getByRole("textbox", { name: "Email" }), "person@example.com")
      await user.click(screen.getByRole("button", { name: "Continue with email" }))

      const track = screen.getByTestId("sign-in-step-track")
      expect(track).toHaveAttribute("data-step-view", "prepare-to-code")
      expect(screen.getByTestId("sign-in-email-pane")).toHaveAttribute("aria-hidden", "true")
      expect(screen.getByTestId("sign-in-code-pane")).toBeVisible()
      expect(screen.getByTestId("otp-field-stub")).toHaveAttribute("data-autofocus", "false")
      expect(screen.getByTestId("otp-field-stub")).not.toHaveFocus()

      act(() => {
        const next = rafQueue.shift()
        next?.(16)
      })
      expect(track).toHaveAttribute("data-step-view", "sliding-to-code")
      expect(track.style.transform).toBe("translate3d(-100%, 0, 0)")

      act(() => {
        const ev = new Event("transitionend", { bubbles: true })
        Object.defineProperty(ev, "propertyName", { value: "transform" })
        fireEvent(track, ev)
      })
      expect(track).toHaveAttribute("data-step-view", "code")
      expect(screen.queryByTestId("sign-in-email-pane")).toBeNull()
      expect(screen.queryByTestId("sign-in-mobile-typewriter")).toBeNull()
      expect(screen.getByTestId("otp-field-stub")).toHaveFocus()

      await user.click(screen.getByRole("button", { name: "Use a different email" }))
      expect(track).toHaveAttribute("data-step-view", "prepare-to-email")
      expect(track.style.transform).toBe("translate3d(-100%, 0, 0)")

      act(() => {
        while (rafQueue.length > 0) {
          rafQueue.shift()?.(32)
        }
      })
      expect(track).toHaveAttribute("data-step-view", "sliding-to-email")
      expect(track.style.transform).toBe("translate3d(0%, 0, 0)")

      act(() => {
        const ev = new Event("transitionend", { bubbles: true })
        Object.defineProperty(ev, "propertyName", { value: "transform" })
        fireEvent(track, ev)
      })
      expect(track).toHaveAttribute("data-step-view", "email")
      expect(screen.queryByTestId("sign-in-code-pane")).toBeNull()
      expect(screen.getByTestId("sign-in-mobile-typewriter")).toBeVisible()
    } finally {
      window.requestAnimationFrame = origRaf
      window.cancelAnimationFrame = origCancelRaf
    }
  })
})
