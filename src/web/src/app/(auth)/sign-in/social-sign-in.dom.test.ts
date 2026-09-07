import { createElement } from "react"
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
