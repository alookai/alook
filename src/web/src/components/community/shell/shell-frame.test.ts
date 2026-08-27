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
    pendingHref: { current: null as string | null },
    navigationPending: { current: false },
    serverCache: new Set<string>(),
    breakpoint: { current: "desktop" },
    onboardingState: { current: null as Record<string, unknown> | null },
    replace: vi.fn(),
    push: vi.fn(),
    registerUiHandlers: vi.fn(),
    handlers,
    rail: {
      railProps: {},
      navigate: handlers.navigate,
      cancelPendingNavigation: handlers.cancelPendingNavigation,
    },
    railOptions: vi.fn(),
    profile: {
      previewImage: handlers.previewImage,
      previewAttachment: handlers.previewAttachment,
      openProfile: handlers.openProfile,
    },
    inbox: {},
  }
})

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    getQueryData: (key: unknown[]) => mocks.serverCache.has(String(key.at(-1)))
      ? { id: key.at(-1) }
      : undefined,
  }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint.current }))
vi.mock("@/lib/community-onboarding", () => ({
  useCommunityOnboarding: () => mocks.onboardingState.current,
}))
vi.mock("./use-community-navigation-controller", () => ({
  useCommunityNavigationController: () => ({
    currentHref: mocks.currentHref.current,
    navigationPending: mocks.navigationPending.current,
    pendingHref: mocks.pendingHref.current,
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
  useShellRailController: (options: unknown) => {
    mocks.railOptions(options)
    return mocks.rail
  },
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
    mocks.pendingHref.current = null
    mocks.navigationPending.current = false
    mocks.serverCache.clear()
    mocks.breakpoint.current = "desktop"
    mocks.onboardingState.current = null
    mocks.registerUiHandlers.mockClear()
    mocks.replace.mockClear()
    mocks.push.mockClear()
    mocks.railOptions.mockClear()
  })

  afterEach(() => vi.unstubAllGlobals())

  it("derives list and detail surfaces from the pathname", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })
    expect(renderer.root.findByType("shell-frame-view").props.surface).toBe("list")
    expect(renderer.root.findByType("shell-frame-view").props.loadingHref).toBe("/c/channels/s1")

    mocks.currentHref.current = "/c/channels/s1/c1?keep=1"
    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "next"))
    })
    expect(renderer.root.findByType("shell-frame-view").props.surface).toBe("detail")
  })

  it("uses the pending destination surface before the committed href changes", async () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s1"
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })
    expect(renderer.root.findByType("shell-frame-view").props.surface).toBe("list")
    expect(renderer.root.findByType("shell-frame-view").props.loadingHref).toBe("/c/channels/s1")

    mocks.pendingHref.current = "/c/me/dm_1?from=inbox"
    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "next"))
    })
    expect(renderer.root.findByType("shell-frame-view").props.surface).toBe("detail")
    expect(renderer.root.findByType("shell-frame-view").props.loadingHref)
      .toBe("/c/me/dm_1?from=inbox")
  })

  it("projects one cold cross-server target into rail, middle, and right", async () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s2"
    mocks.navigationPending.current = true
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })

    const view = renderer.root.findByType("shell-frame-view")
    expect(view.props).toMatchObject({
      surface: "list",
      loadingHref: "/c/channels/s2",
      navigationPending: true,
      serverSwitchTargetId: "s2",
    })
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      activeServerId: "s1",
      projectedActiveServerId: "s2",
    }))
  })

  it("lets an exact warm target skip both forced checkpoints without relabeling A", async () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s2"
    mocks.navigationPending.current = true
    mocks.serverCache.add("s2")
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })

    const view = renderer.root.findByType("shell-frame-view")
    expect(view.props).toMatchObject({
      surface: "detail",
      loadingHref: "/c/channels/s1/c1",
      navigationPending: false,
      serverSwitchTargetId: null,
    })
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      activeServerId: "s1",
      projectedActiveServerId: "s1",
    }))
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

  it("returns mobile server onboarding to the semantic list surface", async () => {
    mocks.breakpoint.current = "mobile"
    mocks.currentHref.current = "/c/me/dm_1"
    mocks.onboardingState.current = { status: "active", stage: "server" }

    await act(async () => {
      TestRenderer.create(createElement(ShellFrame, baseProps))
    })

    expect(mocks.replace).toHaveBeenCalledWith("/c/me")
  })

  it("keeps mobile server onboarding stable on an existing list surface", async () => {
    mocks.breakpoint.current = "mobile"
    mocks.currentHref.current = "/c/me"
    mocks.onboardingState.current = { status: "active", stage: "server" }

    await act(async () => {
      TestRenderer.create(createElement(ShellFrame, baseProps))
    })

    expect(mocks.replace).not.toHaveBeenCalled()
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

  it("passes the single resolved breakpoint to the rail controller", async () => {
    mocks.breakpoint.current = "unknown"
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrame, baseProps))
    })
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({ breakpoint: "unknown" }))

    mocks.breakpoint.current = "mobile"
    await act(async () => {
      renderer.update(createElement(ShellFrame, baseProps, "mobile"))
    })
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({ breakpoint: "mobile" }))
  })
})
