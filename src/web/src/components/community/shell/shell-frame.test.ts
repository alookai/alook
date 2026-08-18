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
    currentHref: { current: "/c/channels/s1" },
    breakpoint: { current: "desktop" },
    replace: vi.fn(),
    push: vi.fn(),
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

vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint.current }))
vi.mock("./use-community-navigation-controller", () => ({
  useCommunityNavigationController: () => ({
    currentHref: mocks.currentHref.current,
    navigationPending: false,
    push: mocks.push,
    replace: mocks.replace,
    prefetch: vi.fn(),
    resolveAndPush: vi.fn(),
    cancelPendingNavigation: mocks.handlers.cancelPendingNavigation,
  }),
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
    mocks.currentHref.current = "/c/channels/s1"
    mocks.breakpoint.current = "desktop"
    mocks.registerUiHandlers.mockClear()
    mocks.replace.mockClear()
    mocks.push.mockClear()
  })

  afterEach(() => vi.unstubAllGlobals())

  it("derives list and detail surfaces from the pathname", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })
    expect(renderer.root.findByType("shell-frame-view").props.surface).toBe("list")

    mocks.currentHref.current = "/c/channels/s1/c1?keep=1"
    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "next"))
    })
    expect(renderer.root.findByType("shell-frame-view").props.surface).toBe("detail")
  })

  it("replaces a mobile detail with its semantic parent", async () => {
    mocks.breakpoint.current = "mobile"
    mocks.currentHref.current = "/c/channels/s1/c1"
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })
    const handlers = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    handlers.goBackMobile()
    expect(mocks.replace).toHaveBeenLastCalledWith("/c/channels/s1")
  })

  it("registers the shared navigation and UI handlers", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })
    const first = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    expect(Object.keys(first).sort()).toEqual([
      "cancelPendingNavigation",
      "goBackMobile",
      "navigate",
      "navigatePath",
      "openProfile",
      "previewAttachment",
      "previewImage",
      "replacePath",
    ])

    mocks.currentHref.current = "/c/channels/s1/c1?msg=m1"
    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "message"))
    })
    const withMessage = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    withMessage.goBackMobile()
    expect(mocks.replace).toHaveBeenLastCalledWith("/c/channels/s1")

    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "rerender"))
    })
    const second = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    expect(second.navigatePath).toBe(withMessage.navigatePath)
    expect(second.replacePath).toBe(withMessage.replacePath)
  })
})
