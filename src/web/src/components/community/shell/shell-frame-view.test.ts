import { createElement, useState } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ShellFrameView } from "./shell-frame-view"

const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  disconnect: vi.fn(),
  onLayoutChanged: vi.fn(),
  resizeCallback: { current: undefined as undefined | ((entries: Array<{ contentRect: { width: number } }>) => void) },
}))

vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({ defaultLayout: { sidebar: 24, main: 76 }, onLayoutChanged: mocks.onLayoutChanged }),
}))
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: (props: Record<string, unknown>) => createElement("panel-group", props),
  ResizablePanel: (props: Record<string, unknown>) => createElement("panel", props),
  ResizableHandle: (props: Record<string, unknown>) => createElement("panel-handle", props),
}))
vi.mock("@/components/ui/app-surface", () => ({
  AppSurface: (props: Record<string, unknown>) => createElement("app-surface", props),
}))
vi.mock("./shell", () => ({
  Shell: (props: Record<string, unknown>) => createElement("shell-root", props),
}))
vi.mock("./server-rail", () => ({
  ServerRail: (props: Record<string, unknown>) => createElement("server-rail", props),
}))
vi.mock("./user-bar", () => ({
  UserBar: (props: Record<string, unknown>) => createElement("user-bar", props),
}))
vi.mock("./community-inbox-popover", () => ({
  InboxPopover: (props: Record<string, unknown>) => createElement("inbox-popover", props),
}))
vi.mock("./shell-frame-overlays", () => ({
  ShellFrameOverlays: (props: Record<string, unknown>) => createElement("shell-overlays", props),
}))
vi.mock("./community-pending-frame", () => ({
  CommunityPendingFrame: (props: Record<string, unknown>) => createElement("channel-loading-frame", props),
}))

const rail = { railProps: { activeServerId: "s1" } } as never
const profile = {
  currentUser: { id: "u1", name: "User", avatar: "U" },
  openProfile: vi.fn(),
  openUserSettings: vi.fn(),
  profile: {
    initialStatusEmoji: "🌱",
    initialStatusText: "Growing",
  },
} as never
const inbox = {
  popoverProps: { unreads: [], unreadDms: [], mentions: [], marked: [], onOpenForumThread: vi.fn() },
  hasUnread: false,
  open: false,
  onOpenChange: vi.fn(),
} as never

describe("ShellFrameView", () => {
  beforeEach(() => {
    mocks.observe.mockClear()
    mocks.disconnect.mockClear()
    mocks.resizeCallback.current = undefined
    class ResizeObserverMock {
      constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
        mocks.resizeCallback.current = callback
      }
      observe = mocks.observe
      disconnect = mocks.disconnect
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
  })

  it("keeps responsive detail shell zones while the breakpoint is unknown", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameView, {
        breakpoint: "unknown",
        surface: "detail",
        loadingHref: "/c/me/dm_1",
        navigationPending: false,
        sidebar: () => createElement("sidebar-content"),
        cancelPendingNavigation: vi.fn(),
        rail,
        profile,
        inbox,
      }, createElement("main-content")))
    })
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(2)
    expect(renderer.root.findAllByType("server-rail")).toHaveLength(1)
    expect(renderer.root.findAllByProps({ className: "hidden sm:contents" })).toHaveLength(1)
    expect(renderer.root.findAllByType("sidebar-content")).toHaveLength(1)
    expect(renderer.root.findAllByType("user-bar")).toHaveLength(1)
    expect(renderer.root.findByProps({ "data-slot": "community-user-bar-overlay" }).props.className)
      .toContain("max-sm:hidden")
    expect(renderer.root.findAllByType("main-content")).toHaveLength(0)
    expect(renderer.root.findAllByType("shell-overlays")).toHaveLength(0)
  })

  it("keeps rail, sidebar, and UserBar in the unknown list shell", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameView, {
        breakpoint: "unknown",
        surface: "list",
        loadingHref: "/c/me",
        navigationPending: false,
        sidebar: () => createElement("sidebar-content"),
        cancelPendingNavigation: vi.fn(),
        rail,
        profile,
        inbox,
      }, createElement("main-content")))
    })
    expect(renderer.root.findAllByType("server-rail")).toHaveLength(1)
    expect(renderer.root.findAllByType("sidebar-content")).toHaveLength(1)
    expect(renderer.root.findAllByType("user-bar")).toHaveLength(1)
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(1)
    expect(renderer.root.findAllByType("main-content")).toHaveLength(0)
  })

  it("keeps the desktop panel geometry, order, and seeded overlay call", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameView, {
        breakpoint: "desktop",
        surface: "detail",
        loadingHref: "/c/channels/s1/c1",
        navigationPending: false,
        sidebar,
        cancelPendingNavigation: vi.fn(),
        rail,
        profile,
        inbox,
        extraDialogs: createElement("extra-dialog"),
      }, createElement("main-content")), { createNodeMock: () => ({ offsetWidth: 240 }) })
    })

    const shell = renderer.root.findByType("shell-root")
    const hostTypes = shell.findAll((node) => typeof node.type === "string").map((node) => node.type)
    expect(hostTypes.indexOf("server-rail")).toBeLessThan(hostTypes.indexOf("app-surface"))
    expect(hostTypes.indexOf("app-surface")).toBeLessThan(hostTypes.indexOf("user-bar"))
    expect(hostTypes.indexOf("user-bar")).toBeLessThan(hostTypes.indexOf("shell-overlays"))
    expect(renderer.root.findAllByType("shell-overlays")).toHaveLength(1)
    expect(renderer.root.findByType("server-rail").props.bottomInset).toBe(60)
    const group = renderer.root.findByType("panel-group")
    expect(group.props.id).toBe("community-shell")
    expect(group.props.orientation).toBe("horizontal")
    expect(group.props.disabled).toBe(false)
    const [sidebarPanel, mainPanel] = renderer.root.findAllByType("panel")
    expect(sidebarPanel.props).toMatchObject({ id: "sidebar", defaultSize: "24%", minSize: 160, maxSize: 360 })
    expect(sidebarPanel.props.className).toContain("pb-15")
    expect(mainPanel.props).toMatchObject({ id: "main", defaultSize: "76%" })
    expect(renderer.root.findByType("shell-overlays").props.profileStatusSeeds).toEqual({
      initialStatusEmoji: "🌱",
      initialStatusText: "Growing",
    })
    expect(sidebar).toHaveBeenCalledWith()
    expect(mocks.observe).toHaveBeenCalledTimes(1)
    const userBarOverlay = renderer.root.find(
      (node) => node.props.style?.marginLeft === -56,
    )
    expect(userBarOverlay.props.style.width).toBe(297)
    await act(async () => {
      mocks.resizeCallback.current?.([{ contentRect: { width: 300 } }])
    })
    expect(userBarOverlay.props.style.width).toBe(357)

    await act(async () => renderer.unmount())
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
  })

  it("composes the server-root list surface with desktop rail, sidebar, and landing content", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameView, {
        breakpoint: "desktop",
        surface: "list",
        loadingHref: "/c/channels/s1",
        navigationPending: false,
        sidebar,
        cancelPendingNavigation: vi.fn(),
        rail,
        profile,
        inbox,
      }, createElement("main-content")), { createNodeMock: () => ({ offsetWidth: 240 }) })
    })

    expect(renderer.root.findAllByType("server-rail")).toHaveLength(1)
    expect(renderer.root.findAllByType("sidebar-content")).toHaveLength(1)
    expect(renderer.root.findAllByType("main-content")).toHaveLength(1)
    expect(sidebar).toHaveBeenCalledWith()

    await act(async () => renderer.unmount())
  })

  it("keeps one responsive skeleton while mobile nav and detail geometry stay distinct", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameView, {
        breakpoint: "mobile",
        surface: "list",
        loadingHref: "/c/me",
        navigationPending: false,
        sidebar,
        cancelPendingNavigation: vi.fn(),
        rail,
        profile,
        inbox,
      }, createElement("main-content")))
    })
    expect(renderer.root.findAllByType("server-rail")).toHaveLength(1)
    expect(renderer.root.findAllByType("user-bar")).toHaveLength(1)
    const mobileSidebarPanel = renderer.root.findAllByType("panel")[0]!
    expect(mobileSidebarPanel.props.className).toContain("pb-15")
    const mobileUserBarOverlay = renderer.root.findByProps({
      "data-slot": "community-user-bar-overlay",
    })
    expect(mobileUserBarOverlay.props.style).toEqual({
      width: "calc(100% + 56px)",
      marginLeft: -56,
    })
    const mobileSurface = renderer.root.findByType("app-surface")
    expect(mobileSurface.props.className).toContain("rounded-tl-xl")
    expect(mobileSurface.props.className).toContain("border-l")
    expect(mobileSurface.props.className).toContain("border-t")
    expect(renderer.root.findAllByType("main-content")).toHaveLength(1)
    expect(renderer.root.findAllByType("panel")[0]?.props.hidden).toBe(false)
    expect(renderer.root.findAllByType("panel")[1]?.props.hidden).toBe(true)
    expect(renderer.root.findAllByType("panel")[0]?.props["data-mobile-active"]).toBe(true)
    expect(renderer.root.findAllByType("panel")[1]?.props["data-mobile-active"]).toBeUndefined()
    expect(renderer.root.findByType("panel-group").props.disabled).toBe(true)
    expect(renderer.root.findByType("panel-group").props.className).toContain("*:data-[mobile-active=true]:flex-1!")
    expect(renderer.root.findAllByType("shell-overlays")).toHaveLength(1)
    expect("profileStatusSeeds" in renderer.root.findByType("shell-overlays").props).toBe(false)
    expect(sidebar).toHaveBeenCalledWith({ noHeader: false })

    await act(async () => {
      renderer.update(createElement(ShellFrameView, {
        breakpoint: "mobile",
        surface: "detail",
        loadingHref: "/c/me/dm_1",
        navigationPending: false,
        sidebar,
        cancelPendingNavigation: vi.fn(),
        rail,
        profile,
        inbox,
      }, createElement("main-content")))
    })
    expect(renderer.root.findAllByType("server-rail")).toHaveLength(0)
    expect(renderer.root.findAllByType("user-bar")).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "data-slot": "community-user-bar-overlay" })).toHaveLength(0)
    expect(renderer.root.findAllByType("app-surface")).toHaveLength(1)
    expect(renderer.root.findByType("app-surface").props.className).toContain("rounded-none")
    expect(renderer.root.findAllByType("main-content")).toHaveLength(1)
    expect(renderer.root.findAllByType("panel")[0]?.props.hidden).toBe(true)
    expect(renderer.root.findAllByType("panel")[1]?.props.hidden).toBe(false)
    expect(renderer.root.findAllByType("panel")[0]?.props["data-mobile-active"]).toBeUndefined()
    expect(renderer.root.findAllByType("panel")[1]?.props["data-mobile-active"]).toBe(true)
    expect(renderer.root.findAllByType("shell-overlays")).toHaveLength(1)
  })

  it("preserves child component identity across the 639 to 640 breakpoint", async () => {
    let mounts = 0
    function StatefulMain() {
      const [identity] = useState(() => ++mounts)
      return createElement("stateful-main", { identity })
    }
    const common = {
      surface: "detail" as const,
      loadingHref: "/c/me/dm_1",
      navigationPending: false,
      sidebar: () => createElement("sidebar-content"),
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          ShellFrameView,
          { ...common, breakpoint: "mobile" },
          createElement(StatefulMain),
        ),
        { createNodeMock: () => ({ offsetWidth: 240 }) },
      )
    })
    expect(renderer.root.findByType("stateful-main").props.identity).toBe(1)

    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        { ...common, breakpoint: "desktop" },
        createElement(StatefulMain),
      ))
    })
    expect(renderer.root.findByType("stateful-main").props.identity).toBe(1)
    expect(mounts).toBe(1)
  })

  it("disconnects and re-subscribes sidebar observation across breakpoint changes", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    const common = {
      surface: "list" as const,
      loadingHref: "/c/me",
      navigationPending: false,
      sidebar,
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ShellFrameView, { ...common, breakpoint: "desktop" }, createElement("main-content")),
        { createNodeMock: () => ({ offsetWidth: 240 }) },
      )
    })
    expect(mocks.observe).toHaveBeenCalledTimes(1)

    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        { ...common, breakpoint: "mobile" },
        createElement("main-content"),
      ))
    })
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.observe).toHaveBeenCalledTimes(1)

    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        { ...common, breakpoint: "desktop" },
        createElement("main-content"),
      ))
    })
    expect(mocks.observe).toHaveBeenCalledTimes(2)

    await act(async () => renderer.unmount())
    expect(mocks.disconnect).toHaveBeenCalledTimes(2)
  })

  it("replaces committed content with immediate pending feedback in every shell zone", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    const common = {
      sidebar,
      loadingHref: "/c/me/friends",
      cancelPendingNavigation: vi.fn(),
      navigationPending: true,
      rail,
      profile,
      inbox,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        ShellFrameView,
        { ...common, breakpoint: "desktop", surface: "detail" },
        createElement("main-content"),
      ), { createNodeMock: () => ({ offsetWidth: 240 }) })
    })
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(1)
    expect(renderer.root.findAllByType("main-content")).toHaveLength(0)
    expect(renderer.root.findAllByType("server-rail")).toHaveLength(1)
    expect(renderer.root.findAllByType("user-bar")).toHaveLength(1)

    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        { ...common, breakpoint: "mobile", surface: "list" },
        createElement("main-content"),
      ))
    })
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(1)
    expect(renderer.root.findAllByType("server-rail")).toHaveLength(1)
    expect(renderer.root.findAllByType("sidebar-content")).toHaveLength(1)
    expect(renderer.root.findAllByType("user-bar")).toHaveLength(1)
    expect(renderer.root.findAll((node) =>
      typeof node.props.className === "string" &&
      node.props.className.includes("absolute inset-0 z-20")))
      .toHaveLength(0)
    expect(renderer.root.findAllByType("panel")[1]!.findAllByType("channel-loading-frame"))
      .toHaveLength(1)

    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        { ...common, breakpoint: "mobile", surface: "detail" },
        createElement("main-content"),
      ))
    })
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(1)
    expect(renderer.root.findAllByType("main-content")).toHaveLength(0)
    expect(renderer.root.findAllByType("server-rail")).toHaveLength(0)
    expect(renderer.root.findAllByType("user-bar")).toHaveLength(0)
    expect(renderer.root.findByType("channel-loading-frame").props.reserveBackSlot).toBe(true)
    expect(renderer.root.findByType("channel-loading-frame").props.onBack).toBeUndefined()
  })
})
