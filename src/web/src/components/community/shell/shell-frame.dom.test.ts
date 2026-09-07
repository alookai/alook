import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
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
    inboxOptions: vi.fn(),
    profile: {
      previewImage: handlers.previewImage,
      previewAttachment: handlers.previewAttachment,
      openProfile: handlers.openProfile,
    },
    inbox: {},
    viewProps: { current: {} as Record<string, unknown> },
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
    publishedHref: mocks.currentHref.current,
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
vi.mock("@/stores/community/ws", () => ({
  useCommunityWsStore: (selector: (state: { accessEpoch: number }) => unknown) => selector({ accessEpoch: 0 }),
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer" }),
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
  useShellInboxController: (options: unknown) => {
    mocks.inboxOptions(options)
    return mocks.inbox
  },
}))
vi.mock("./shell-frame-view", () => ({
  ShellFrameView: (props: Record<string, unknown>) => {
    mocks.viewProps.current = props
    return createElement("div", { "data-testid": "shell-frame-view" })
  },
}))

const baseProps = {
  view: "server" as const,
  activeServerId: "s1",
  frameHref: "/c/channels/s1",
  sidebar: () => createElement("sidebar"),
}

function checkpoint() {
  return mocks.viewProps.current.checkpoint as Record<string, unknown>
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
    mocks.inboxOptions.mockClear()
  })

  afterEach(() => vi.unstubAllGlobals())

  it("does not rewrite the committed frame from an eagerly published pathname", () => {
    const renderer = render(createElement(ShellFrame, baseProps))
    expect(checkpoint().surface).toBe("list")
    expect(checkpoint().targetHref).toBe("/c/channels/s1")

    mocks.currentHref.current = "/c/channels/s1/c1?keep=1"
    renderer.rerender(createElement(ShellFrame, baseProps, "next"))
    expect(checkpoint().surface).toBe("list")
  })

  it("advances the committed descriptor from layout-owned frameHref", () => {
    mocks.currentHref.current = "/c/channels/s1/c2"
    mocks.pendingHref.current = "/c/channels/s1/c2"
    mocks.navigationPending.current = true
    const sourceProps = { ...baseProps, frameHref: "/c/channels/s1/c1" }
    const renderer = render(createElement(ShellFrame, sourceProps))
    expect(checkpoint().mode).toBe("same-scope-leaf")

    renderer.rerender(createElement(ShellFrame, {
      ...sourceProps,
      frameHref: "/c/channels/s1/c2",
    }))
    expect(checkpoint().mode).toBe("committed")
  })

  it("keeps the committed surface until exact frame evidence arrives", () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s1"
    mocks.navigationPending.current = true
    const sourceProps = { ...baseProps, frameHref: "/c/channels/s1/c1" }
    const renderer = render(createElement(ShellFrame, sourceProps))
    expect(checkpoint()).toMatchObject({
      surface: "list",
      targetHref: "/c/channels/s1",
      main: { kind: "keep" },
    })
    expect(mocks.inboxOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      publishedHref: "/c/channels/s1/c1",
      navigationPending: true,
      pendingHref: "/c/channels/s1",
    }))

    mocks.pendingHref.current = "/c/me/dm_1?from=inbox"
    renderer.rerender(createElement(ShellFrame, sourceProps, "next"))
    expect(checkpoint()).toMatchObject({
      surface: "detail",
      targetHref: "/c/me/dm_1?from=inbox",
    })
  })

  it("projects one cold cross-server target into rail, middle, and right", () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s2"
    mocks.navigationPending.current = true
    render(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }))

    expect(checkpoint()).toMatchObject({
      mode: "cold-scope",
      surface: "list",
      targetHref: "/c/channels/s2",
      sidebar: { kind: "server-skeleton", serverId: "s2" },
    })
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      activeServerId: "s1",
      projectedView: "server",
      projectedActiveServerId: "s2",
    }))
  })

  it("lets an exact warm target skip both forced checkpoints without relabeling A", () => {
    mocks.currentHref.current = "/c/channels/s1/c1"
    mocks.pendingHref.current = "/c/channels/s2"
    mocks.navigationPending.current = true
    mocks.serverCache.add("s2")
    render(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }))

    expect(checkpoint()).toMatchObject({
      mode: "warm-scope",
      surface: "list",
      targetHref: "/c/channels/s2",
      main: { kind: "keep" },
    })
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      activeServerId: "s1",
      projectedView: "server",
      projectedActiveServerId: "s1",
    }))
  })

  it("replaces a mobile detail with its semantic parent", () => {
    mocks.breakpoint.current = "mobile"
    mocks.currentHref.current = "/c/channels/s1/c1"
    render(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }))
    const handlers = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    handlers.goBackMobile()
    expect(mocks.replace).toHaveBeenLastCalledWith("/c/channels/s1")
  })

  it("returns mobile server onboarding to the semantic list surface", () => {
    mocks.breakpoint.current = "mobile"
    mocks.currentHref.current = "/c/me/dm_1"
    mocks.onboardingState.current = { status: "active", stage: "server" }

    render(createElement(ShellFrame, {
      ...baseProps,
      view: "dm",
      activeServerId: undefined,
      frameHref: "/c/me/dm_1",
    }))

    expect(mocks.replace).toHaveBeenCalledWith("/c/me")
  })

  it("keeps mobile server onboarding stable on an existing list surface", () => {
    mocks.breakpoint.current = "mobile"
    mocks.currentHref.current = "/c/me"
    mocks.onboardingState.current = { status: "active", stage: "server" }

    render(createElement(ShellFrame, {
      ...baseProps,
      view: "dm",
      activeServerId: undefined,
      frameHref: "/c/me",
    }))

    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("registers the shared navigation and UI handlers", () => {
    const renderer = render(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }))
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
    renderer.rerender(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }, "message"))
    const withMessage = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    withMessage.goBackMobile()
    expect(mocks.replace).toHaveBeenLastCalledWith("/c/channels/s1")

    renderer.rerender(createElement(ShellFrame, {
      ...baseProps,
      frameHref: "/c/channels/s1/c1",
    }, "rerender"))
    const second = mocks.registerUiHandlers.mock.calls.at(-1)?.[0]
    expect(second.navigatePath).toBe(withMessage.navigatePath)
    expect(second.replacePath).toBe(withMessage.replacePath)
  })

  it("passes the single resolved breakpoint to the rail controller", () => {
    mocks.breakpoint.current = "unknown"
    const renderer = render(createElement(ShellFrame, baseProps))
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({ breakpoint: "unknown" }))

    mocks.breakpoint.current = "mobile"
    renderer.rerender(createElement(ShellFrame, baseProps, "mobile"))
    expect(mocks.railOptions).toHaveBeenLastCalledWith(expect.objectContaining({ breakpoint: "mobile" }))
  })
})
