import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
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
    registerUiHandlers: vi.fn(),
    setMobileZone: vi.fn(),
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
}))
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
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
  mobileZone: "messages" as const,
  setMobileZone: mocks.setMobileZone,
  sidebar: () => createElement("sidebar"),
  goHome: vi.fn(),
  goServer: vi.fn(),
}

describe("ShellFrame orchestration", () => {
  beforeEach(() => {
    mocks.onboarding.current = { status: "active", stage: "server" }
    mocks.pathname.current = "/c/channels/s1"
    mocks.registerUiHandlers.mockClear()
    mocks.setMobileZone.mockClear()
  })

  it("maps active onboarding stages to the existing mobile zones", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })
    expect(mocks.setMobileZone).toHaveBeenLastCalledWith("nav")

    mocks.onboarding.current = { status: "active", stage: "channel" }
    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "next"))
    })
    expect(mocks.setMobileZone).toHaveBeenLastCalledWith("messages")

    mocks.onboarding.current = { status: "complete" }
    mocks.setMobileZone.mockClear()
    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "done"))
    })
    expect(mocks.setMobileZone).not.toHaveBeenCalled()
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

    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "rerender"))
    })
    const second = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    for (const key of Object.keys(first)) expect(second[key]).toBe(first[key])
  })
})
