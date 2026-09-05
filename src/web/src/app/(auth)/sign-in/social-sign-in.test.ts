import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { NativeOauthView } from "@/lib/native-oauth-client"
const mocks = vi.hoisted(() => ({ tauri: false, social: vi.fn(), start: vi.fn(), cancel: vi.fn(), dispose: vi.fn(), emit: undefined as undefined | ((view: NativeOauthView) => void) }))
vi.mock("@alook/shared", async importOriginal => ({ ...await importOriginal<typeof import("@alook/shared")>(), isTauri: () => mocks.tauri }))
vi.mock("@/lib/auth-client", () => ({ signIn: { social: mocks.social } }))
vi.mock("@/lib/native-oauth-client", () => ({ nativeOauthBrowserDeps: {}, createNativeOauthController: (_deps: unknown, changed: (view: NativeOauthView) => void) => {
  mocks.emit = changed
  return { connect: async () => changed({ phase: "idle", attempt: null }), start: mocks.start, cancel: mocks.cancel, dispose: mocks.dispose }
} }))
import { SocialSignIn } from "./social-sign-in"
let renderer: TestRenderer.ReactTestRenderer | undefined
afterEach(async () => { await act(async () => { renderer?.unmount() }); renderer = undefined; mocks.tauri = false; vi.clearAllMocks() })
function button(id: string) { return renderer!.root.findAllByType("button").find(b => b.props["data-testid"] === id)! }
describe("social sign-in native boundary", () => {
  it("preserves normal browser social login and callback destination", async () => {
    await act(async () => { renderer = TestRenderer.create(createElement(SocialSignIn, { postLoginUrl: "/c/me?tab=1" })) })
    await act(async () => { button("native-oauth-google").props.onClick() })
    expect(mocks.social).toHaveBeenCalledWith({ provider: "google", callbackURL: "/c/me?tab=1" })
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it("never falls back to embedded social OAuth in Tauri, including unsupported apps", async () => {
    mocks.tauri = true
    await act(async () => { renderer = TestRenderer.create(createElement(SocialSignIn, { postLoginUrl: "/%5cevil" })) })
    await act(async () => { button("native-oauth-github").props.onClick() })
    expect(mocks.start).toHaveBeenCalledWith("github", "/c/me")
    expect(mocks.social).not.toHaveBeenCalled()
    await act(async () => { mocks.emit!({ phase: "unsupported", attempt: null }) })
    expect(button("native-oauth-google").props.disabled).toBe(true)
    expect(JSON.stringify(renderer!.toJSON())).toContain("You can still use email")
  })
  it("shows bounded progress, Cancel and Retry controls without rendering proof data", async () => {
    mocks.tauri = true
    await act(async () => { renderer = TestRenderer.create(createElement(SocialSignIn, { postLoginUrl: "/c/me" })) })
    const attempt = { attemptId: "opaque-id", provider: "google" as const, redirectPath: "/c/me", expiresAt: Date.now()+600_000, waiting: true }
    await act(async () => { mocks.emit!({ phase: "exchanging", attempt }) })
    expect(button("native-oauth-retry").props.disabled).toBe(true)
    expect(button("native-oauth-cancel").props.disabled).not.toBe(true)
    await act(async () => { button("native-oauth-cancel").props.onClick() })
    expect(mocks.cancel).toHaveBeenCalledOnce()
    await act(async () => { mocks.emit!({ phase: "error", message: "retry_required", attempt }) })
    await act(async () => { button("native-oauth-retry").props.onClick() })
    expect(mocks.start).toHaveBeenCalledWith("google", "/c/me")
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("opaque-id")
  })
})
