import { createElement } from "react"
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NativeOauthView } from "@/lib/native-oauth-client"
import { act, render, screen, setupUser } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  tauri: false,
  social: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  dispose: vi.fn(),
  emit: undefined as undefined | ((view: NativeOauthView) => void),
}))

vi.mock("@alook/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@alook/shared")>(),
  isTauri: () => mocks.tauri,
}))
vi.mock("@/lib/auth-client", () => ({ signIn: { social: mocks.social } }))
vi.mock("@/lib/native-oauth-client", () => ({
  nativeOauthBrowserDeps: {},
  createNativeOauthController: (
    _deps: unknown,
    changed: (view: NativeOauthView) => void,
  ) => {
    mocks.emit = changed
    return {
      connect: async () => changed({ phase: "idle", attempt: null }),
      start: mocks.start,
      cancel: mocks.cancel,
      dispose: mocks.dispose,
    }
  },
}))

import { SocialSignIn } from "./social-sign-in"

beforeEach(() => {
  mocks.tauri = false
  mocks.emit = undefined
  vi.clearAllMocks()
})

function button(id: string): HTMLButtonElement {
  return screen.getByTestId(id) as HTMLButtonElement
}

describe("social sign-in native boundary", () => {
  it("preserves normal browser social login and callback destination", async () => {
    const user = setupUser()
    render(createElement(SocialSignIn, { postLoginUrl: "/c/me?tab=1" }))

    await user.click(button("native-oauth-google"))

    expect(mocks.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/c/me?tab=1",
    })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("renders Apple last across both columns and starts the browser flow", async () => {
    const user = setupUser()
    render(createElement(SocialSignIn, {
      postLoginUrl: "/c/me?tab=1",
      appleEnabled: true,
    }))

    const socialButtons = screen.getAllByRole("button")
    expect(socialButtons.map((item) => item.dataset.testid)).toEqual([
      "native-oauth-github",
      "native-oauth-google",
      "native-oauth-apple",
    ])
    const apple = button("native-oauth-apple")
    expect(apple).toHaveClass("col-span-2")
    expect(apple).toHaveClass("bg-apple-signin")
    expect(apple).toHaveAccessibleName("Continue with Apple")
    expect(apple.tabIndex).toBe(0)
    apple.focus()
    expect(apple).toHaveFocus()

    await user.click(apple)
    expect(mocks.social).toHaveBeenCalledWith({
      provider: "apple",
      callbackURL: "/c/me?tab=1",
    })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it("keeps Apple's mandated black-on-light and white-on-dark tokens", () => {
    const css = readFileSync("src/app/globals.css", "utf8")
    expect(css).toMatch(
      /:root\s*\{[^}]*--apple-signin:\s*oklch\(0 0 0\);[^}]*--apple-signin-foreground:\s*oklch\(1 0 0\);/s,
    )
    expect(css).toMatch(
      /\.dark\s*\{[^}]*--apple-signin:\s*oklch\(1 0 0\);[^}]*--apple-signin-foreground:\s*oklch\(0 0 0\);/s,
    )
  })

  it("does not expose Apple when server configuration is absent", () => {
    render(createElement(SocialSignIn, { postLoginUrl: "/c/me" }))
    expect(screen.queryByTestId("native-oauth-apple")).not.toBeInTheDocument()
  })

  it("never falls back to embedded social OAuth in Tauri, including unsupported apps", async () => {
    const user = setupUser()
    mocks.tauri = true
    render(createElement(SocialSignIn, { postLoginUrl: "/%5cevil" }))

    await user.click(button("native-oauth-github"))
    expect(mocks.start).toHaveBeenCalledWith("github", "/c/me")
    expect(mocks.social).not.toHaveBeenCalled()

    act(() => mocks.emit!({ phase: "unsupported", attempt: null }))

    expect(button("native-oauth-google")).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent("You can still use email")
  })

  it("disables only Apple when an older app rejects that provider", () => {
    mocks.tauri = true
    render(createElement(SocialSignIn, {
      postLoginUrl: "/c/me",
      appleEnabled: true,
    }))

    act(() => mocks.emit!({
      phase: "error",
      message: "apple_update_required",
      attempt: null,
    }))

    expect(button("native-oauth-apple")).toBeDisabled()
    expect(button("native-oauth-github")).toBeEnabled()
    expect(button("native-oauth-google")).toBeEnabled()
    expect(screen.queryByTestId("native-oauth-retry")).not.toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub, Google, and email still work")
  })

  it("shows bounded progress, Cancel and Retry controls without rendering proof data", async () => {
    const user = setupUser()
    mocks.tauri = true
    render(createElement(SocialSignIn, { postLoginUrl: "/c/me" }))
    const attempt = {
      attemptId: "opaque-id",
      provider: "google" as const,
      redirectPath: "/c/me",
      expiresAt: Date.now() + 600_000,
      waiting: true,
    }

    act(() => mocks.emit!({ phase: "exchanging", attempt }))
    expect(button("native-oauth-retry")).toBeDisabled()
    expect(button("native-oauth-cancel")).toBeEnabled()

    await user.click(button("native-oauth-cancel"))
    expect(mocks.cancel).toHaveBeenCalledOnce()

    act(() => mocks.emit!({ phase: "error", message: "retry_required", attempt }))
    await user.click(button("native-oauth-retry"))

    expect(mocks.start).toHaveBeenCalledWith("google", "/c/me")
    expect(document.body).not.toHaveTextContent("opaque-id")
  })
})
