import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ShellFrame } from "./shell-frame"

const mocks = vi.hoisted(() => {
  const handlers = {
    previewImage: vi.fn(),
    previewAttachment: vi.fn(),
    openProfile: vi.fn(),
    navigate: vi.fn(),
    cancelPendingNavigation: vi.fn(),
  }
  return {
    onboarding: { current: { status: "active", stage: "server" } as unknown },
    pathname: { current: "/c/channels/s1" },
    searchParams: { current: new URLSearchParams() },
    breakpoint: { current: "desktop" },
    replaceState: vi.fn(),
    registerUiHandlers: vi.fn(),
    handlers,
    rail: {
      railProps: {},
      navigate: handlers.navigate,
      cancelPendingNavigation: handlers.cancelPendingNavigation,
    },
    profile: {
      previewImage: handlers.previewImage,
      previewAttachment: handlers.previewAttachment,
      openProfile: handlers.openProfile,
    },
    inbox: {},
  }
})

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => mocks.pathname.current,
  useSearchParams: () => mocks.searchParams.current,
}))
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint.current }))
vi.mock("@/lib/community-onboarding", () => ({
  useCommunityOnboarding: () => mocks.onboarding.current,
}))
vi.mock("@/stores/community", () => ({
  useCommunityStore: Object.assign(vi.fn(), {
    getState: () => ({ registerUiHandlers: mocks.registerUiHandlers }),
  }),
}))
vi.mock("./use-shell-rail-controller", () => ({
  useShellRailController: () => mocks.rail,
}))
vi.mock("./use-shell-profile-controller", () => ({
  useShellProfileController: () => mocks.profile,
}))
vi.mock("./use-shell-inbox-controller", () => ({
  useShellInboxController: () => mocks.inbox,
}))
vi.mock("./shell-frame-view", () => ({
  ShellFrameView: (props: Record<string, unknown>) => createElement("shell-frame-view", props),
}))

const baseProps = {
  view: "server" as const,
  activeServerId: "s1",
  sidebar: () => createElement("sidebar"),
}

describe("ShellFrame orchestration", () => {
  beforeEach(() => {
    mocks.onboarding.current = { status: "active", stage: "server" }
    mocks.pathname.current = "/c/channels/s1"
    mocks.searchParams.current = new URLSearchParams()
    mocks.breakpoint.current = "desktop"
    mocks.registerUiHandlers.mockClear()
    mocks.replaceState.mockClear()
    vi.stubGlobal("window", {
      history: { replaceState: mocks.replaceState },
      location: { hash: "" },
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it("derives the pane from the current URL and tracks search-param updates", async () => {
    mocks.searchParams.current = new URLSearchParams("pane=nav")
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })
    expect(renderer.root.findByType("shell-frame-view").props.mobileZone).toBe("nav")

    mocks.searchParams.current = new URLSearchParams()
    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "next"))
    })
    expect(renderer.root.findByType("shell-frame-view").props.mobileZone).toBe("messages")
  })

  it("commits onboarding pane changes through native history on mobile", async () => {
    mocks.breakpoint.current = "mobile"
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })
    expect(mocks.replaceState).toHaveBeenLastCalledWith(
      null, "", "/c/channels/s1?pane=nav",
    )

    mocks.searchParams.current = new URLSearchParams("pane=nav")
    mocks.onboarding.current = { status: "active", stage: "channel" }
    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "channel"))
    })
    expect(mocks.replaceState).toHaveBeenLastCalledWith(null, "", "/c/channels/s1")
  })

  it("registers exactly six stable UI handlers", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })
    const first = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    expect(Object.keys(first).sort()).toEqual([
      "cancelPendingNavigation",
      "goBackMobile",
      "navigate",
      "openProfile",
      "previewAttachment",
      "previewImage",
    ])

    mocks.searchParams.current = new URLSearchParams("msg=m1")
    Object.assign(window.location, { hash: "#anchor" })
    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "message"))
    })
    const withMessage = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    withMessage.goBackMobile()
    expect(mocks.replaceState).toHaveBeenLastCalledWith(
      null, "", "/c/channels/s1?msg=m1&pane=nav#anchor",
    )

    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "rerender"))
    })
    const second = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    for (const key of Object.keys(withMessage)) expect(second[key]).toBe(withMessage[key])
  })
})
