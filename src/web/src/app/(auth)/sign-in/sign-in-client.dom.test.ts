import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {},
  signIn: {},
  signUp: {},
}))
vi.mock("./sign-in-fields", () => ({
  SignInEmailField: () => null,
  SignInOtpField: () => null,
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
    mocks.searchParams = new URLSearchParams("redirect=%2Fc%2Fme")
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as never
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
