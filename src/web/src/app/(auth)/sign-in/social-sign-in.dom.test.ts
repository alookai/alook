import { createElement } from "react"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NativeOauthView } from "@/lib/native-oauth-client"
import { act, render, screen, setupUser } from "@/test/react-dom-harness"

const webRoot = existsSync(resolve(process.cwd(), "next.config.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "src/web")

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

  it("keeps every provider's icon and title together at the visual center", async () => {
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
    const github = button("native-oauth-github")
    const google = button("native-oauth-google")
    const apple = button("native-oauth-apple")
    for (const provider of [github, google, apple]) {
      expect(provider).toHaveClass(
        "h-9",
        "border-0",
        "bg-apple-signin",
        "text-base",
        "text-apple-signin-foreground",
        "hover:bg-apple-signin",
      )
    }
    for (const provider of ["github", "google", "apple"]) {
      expect(screen.getByTestId(`native-oauth-${provider}-content`))
        .toHaveClass("inline-flex", "items-center", "gap-2")
    }
    expect(apple).toHaveClass("col-span-2")
    expect(apple).toHaveClass("min-w-35")
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

  it("keeps every provider on Apple's mandated black-on-light and white-on-dark tokens", () => {
    const globalsCss = readFileSync(resolve(webRoot, "src/app/globals.css"), "utf8")
    expect(globalsCss).toMatch(
      /:root\s*\{[^}]*--apple-signin:\s*oklch\(0 0 0\);[^}]*--apple-signin-foreground:\s*oklch\(1 0 0\);/s,
    )
    expect(globalsCss).toMatch(
      /\.dark\s*\{[^}]*--apple-signin:\s*oklch\(1 0 0\);[^}]*--apple-signin-foreground:\s*oklch\(0 0 0\);/s,
    )
    expect(globalsCss).not.toContain("apple-signin-hover")
  })

  it("embeds Apple's official left-aligned logo-with-text artwork", () => {
    render(createElement(SocialSignIn, {
      postLoginUrl: "/c/me",
      appleEnabled: true,
    }))

    const source = readFileSync(resolve(
      webRoot,
      "src/app/(auth)/sign-in/social-sign-in.tsx",
    ), "utf8")
    const artwork = readFileSync(resolve(
      webRoot,
      "src/app/(auth)/sign-in/apple-sign-in-artwork.ts",
    ), "utf8")
    expect(source).not.toContain("SiApple")
    expect(source).not.toContain("appleid.cdn-apple.com/appleid/button/logo")
    expect(artwork).not.toContain("appleid.cdn-apple.com/appleid/button/logo")
    expect(artwork).toContain("Logo-Sign-in-with-Apple.dmg")
    expect(artwork).toContain("Sign in with Apple - Left Aligned")
    const white = screen.getByTestId("apple-official-left-aligned-logo-white")
    const black = screen.getByTestId("apple-official-left-aligned-logo-black")
    expect(white).toHaveAttribute(
      "src",
      expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    )
    expect(white).toHaveAttribute("width", "31")
    expect(white).toHaveAttribute("height", "44")
    expect(white).toHaveClass("col-start-1", "row-start-1", "h-9", "w-auto", "dark:hidden")
    expect(black).toHaveAttribute(
      "src",
      expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    )
    expect(black).toHaveAttribute("width", "31")
    expect(black).toHaveAttribute("height", "44")
    expect(black).toHaveClass("col-start-1", "row-start-1", "h-9", "w-auto", "dark:block")
    expect([white, black].map((image) => createHash("sha256")
      .update(Buffer.from(image.getAttribute("src")!.split(",")[1], "base64"))
      .digest("hex"))).toEqual([
      "f43d1ed5be59bcffdf4c20b5e29f8de041858678f549515377d0ba4f5ebd115e",
      "0f56330a7a4fe2db06ec79fdbfed1eec1d434557f052add6d848daa31877f380",
    ])
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
