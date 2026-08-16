import { createElement } from "react"
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
vi.mock("@/components/community/channels/channel-loading-frame", () => ({
  ChannelLoadingFrame: () => createElement("channel-loading-frame"),
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

  it("keeps the desktop panel geometry, order, and seeded overlay call", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameView, {
        breakpoint: "desktop",
        mobileZone: "messages",
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

  it("keeps mobile nav and messages branches distinct and omits status seeds", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameView, {
        breakpoint: "mobile",
        mobileZone: "nav",
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
    expect(renderer.root.findAllByType("main-content")).toHaveLength(0)
    expect(renderer.root.findAllByType("shell-overlays")).toHaveLength(1)
    expect("profileStatusSeeds" in renderer.root.findByType("shell-overlays").props).toBe(false)
    expect(sidebar).toHaveBeenCalledWith({ noHeader: false })

    await act(async () => {
      renderer.update(createElement(ShellFrameView, {
        breakpoint: "mobile",
        mobileZone: "messages",
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
    expect(renderer.root.findAllByType("main-content")).toHaveLength(1)
    expect(renderer.root.findAllByType("shell-overlays")).toHaveLength(1)
  })

  it("disconnects and re-subscribes sidebar observation across breakpoint changes", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    const common = {
      mobileZone: "nav" as const,
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
        { ...common, breakpoint: "desktop", mobileZone: "messages" },
        createElement("main-content"),
      ), { createNodeMock: () => ({ offsetWidth: 240 }) })
    })
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(1)
    expect(renderer.root.findAllByType("main-content")).toHaveLength(0)

    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        { ...common, breakpoint: "mobile", mobileZone: "nav" },
        createElement("main-content"),
      ))
    })
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(1)

    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        { ...common, breakpoint: "mobile", mobileZone: "messages" },
        createElement("main-content"),
      ))
    })
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(1)
    expect(renderer.root.findAllByType("main-content")).toHaveLength(0)
  })
})
