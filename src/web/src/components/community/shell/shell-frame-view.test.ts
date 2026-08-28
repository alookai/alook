import { createElement, useState } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ShellFrameView } from "./shell-frame-view"
import type { CommunityCheckpointPlan, CommunitySurface } from "@/lib/community/community-route"

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
vi.mock("@/components/community/channels/channel-sidebar", () => ({
  ChannelSidebarSkeleton: (props: Record<string, unknown>) => createElement("channel-sidebar-skeleton", props),
}))
vi.mock("@/components/community/channels/dm-sidebar", () => ({
  DmSidebarSkeleton: (props: Record<string, unknown>) => createElement("dm-sidebar-skeleton", props),
}))

function committedCheckpoint(
  href: string,
  surface: CommunitySurface,
): CommunityCheckpointPlan {
  return {
    mode: "committed",
    surface,
    targetHref: href,
    rail: { kind: "keep" },
    sidebar: { kind: "keep" },
    main: { kind: "keep" },
  }
}

function sameScopePendingCheckpoint(
  committedHref: string,
  committedSurface: CommunitySurface,
  targetHref: string,
): CommunityCheckpointPlan {
  return {
    ...committedCheckpoint(committedHref, committedSurface),
    mode: "same-scope-leaf",
    targetHref,
  }
}

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
    vi.unstubAllGlobals()
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
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })))
  })

  it("keeps responsive detail shell zones while the breakpoint is unknown", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ShellFrameView, {
        breakpoint: "unknown",
        checkpoint: committedCheckpoint("/c/me/dm_1", "detail"),
        sidebar: () => createElement("sidebar-content"),
        cancelPendingNavigation: vi.fn(),
        rail,
        profile,
        inbox,
      }, createElement("main-content")))
    })
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(2)
    const initialRailWrapper = renderer.root.find((node) =>
      node.type === "div"
      && typeof node.props.className === "string"
      && node.props.className.includes("hidden sm:contents"),
    )
    expect(initialRailWrapper.props.className).toContain("min-h-0")
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
        checkpoint: committedCheckpoint("/c/me", "list"),
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
        checkpoint: committedCheckpoint("/c/channels/s1/c1", "detail"),
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
    const desktopRail = renderer.root.findByType("server-rail")
    expect(desktopRail.props.bottomInset).toBe(60)
    expect(renderer.root.findAllByProps({ className: "flex min-h-0" })).toHaveLength(1)
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
        checkpoint: committedCheckpoint("/c/channels/s1", "list"),
        sidebar,
        cancelPendingNavigation: vi.fn(),
        rail,
        profile,
        inbox,
      }, createElement("main-content")), { createNodeMock: () => ({ offsetWidth: 240 }) })
    })

    expect(renderer.root.findAllByType("server-rail")).toHaveLength(1)
    expect(renderer.root.findAllByProps({ className: "flex min-h-0" })).toHaveLength(1)
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
        checkpoint: committedCheckpoint("/c/me", "list"),
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
    const listMotion = renderer.root.findByProps({ "data-community-mobile-surface": "list" })
    expect(listMotion.props.className).toContain("flex")
    expect("profileStatusSeeds" in renderer.root.findByType("shell-overlays").props).toBe(false)
    expect(sidebar).toHaveBeenCalledWith({ noHeader: false })

    await act(async () => {
      renderer.update(createElement(ShellFrameView, {
        breakpoint: "mobile",
        checkpoint: committedCheckpoint("/c/me/dm_1", "detail"),
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
    const detailMotion = renderer.root.findByProps({ "data-community-mobile-surface": "detail" })
    expect(detailMotion.props.className).toContain("flex")
  })

  it("animates committed mobile switches without remounting and skips reduced motion", async () => {
    const cancel = vi.fn()
    const animate = vi.fn(() => ({ cancel }))
    const sidebar = () => createElement("sidebar-content")
    const common = {
      breakpoint: "mobile" as const,
      sidebar,
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        ShellFrameView,
        { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c1", "detail") },
        createElement("main-content"),
      ), { createNodeMock: () => ({ offsetWidth: 240, animate }) })
    })
    expect(animate).not.toHaveBeenCalled()

    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c2", "detail") },
        createElement("main-content"),
      ))
    })
    expect(animate).toHaveBeenCalledOnce()
    expect(animate).toHaveBeenLastCalledWith([
      { opacity: 0.92, transform: "translate3d(8px, 0, 0)" },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], {
      duration: 180,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    })

    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })))
    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c3", "detail") },
        createElement("main-content"),
      ))
    })
    expect(animate).toHaveBeenCalledOnce()
  })

  it("preserves child component identity across the 639 to 640 breakpoint", async () => {
    let mounts = 0
    function StatefulMain() {
      const [identity] = useState(() => ++mounts)
      return createElement("stateful-main", { identity })
    }
    const common = {
      checkpoint: committedCheckpoint("/c/me/dm_1", "detail"),
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
      checkpoint: committedCheckpoint("/c/me", "list"),
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

  it("keeps committed content mounted while same-scope navigation is pending", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    const common = {
      sidebar,
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        ShellFrameView,
        {
          ...common,
          breakpoint: "desktop",
          checkpoint: sameScopePendingCheckpoint("/c/me", "list", "/c/me/friends"),
        },
        createElement("main-content"),
      ), { createNodeMock: () => ({ offsetWidth: 240 }) })
    })
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(0)
    expect(renderer.root.findAllByType("main-content")).toHaveLength(1)
    expect(renderer.root.findAllByType("server-rail")).toHaveLength(1)
    expect(renderer.root.findAllByType("user-bar")).toHaveLength(1)

    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        {
          ...common,
          breakpoint: "mobile",
          checkpoint: sameScopePendingCheckpoint("/c/me", "list", "/c/me/friends"),
        },
        createElement("main-content"),
      ))
    })
    expect(renderer.root.findAllByType("channel-loading-frame")).toHaveLength(0)
    expect(renderer.root.findAllByType("server-rail")).toHaveLength(1)
    expect(renderer.root.findAllByType("sidebar-content")).toHaveLength(1)
    expect(renderer.root.findAllByType("user-bar")).toHaveLength(1)
    expect(renderer.root.findAllByType("main-content")).toHaveLength(1)
  })

  it("replaces the committed sidebar with one target-scoped cold server checkpoint", async () => {
    const sidebar = vi.fn(() => createElement("old-sidebar"))
    const common = {
      cancelPendingNavigation: vi.fn(),
      checkpoint: {
        mode: "cold-scope",
        surface: "list",
        targetHref: "/c/channels/s2",
        rail: { kind: "target", view: "server", activeServerId: "s2" },
        sidebar: { kind: "server-skeleton", serverId: "s2" },
        main: { kind: "target-skeleton", href: "/c/channels/s2" },
      } satisfies CommunityCheckpointPlan,
      sidebar,
      rail,
      profile,
      inbox,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        ShellFrameView,
        { ...common, breakpoint: "desktop" },
        createElement("old-main"),
      ), { createNodeMock: () => ({ offsetWidth: 240 }) })
    })

    expect(sidebar).not.toHaveBeenCalled()
    expect(renderer.root.findAllByType("old-sidebar")).toHaveLength(0)
    expect(renderer.root.findByType("channel-sidebar-skeleton").props.targetServerId).toBe("s2")
    expect(renderer.root.findByType("channel-loading-frame").props.href).toBe("/c/channels/s2")

    await act(async () => {
      renderer.update(createElement(
        ShellFrameView,
        { ...common, breakpoint: "mobile" },
        createElement("old-main"),
      ))
    })
    const [sidebarPanel, mainPanel] = renderer.root.findAllByType("panel")
    expect(sidebarPanel?.props["data-mobile-active"]).toBe(true)
    expect(sidebarPanel?.findAllByType("channel-sidebar-skeleton")).toHaveLength(1)
    expect(mainPanel?.props.hidden).toBe(true)
    expect(sidebar).not.toHaveBeenCalled()
  })

  it("renders an inert me sidebar checkpoint for a cold server-to-home target", async () => {
    const sidebar = vi.fn(() => createElement("old-sidebar"))
    const checkpoint: CommunityCheckpointPlan = {
      mode: "cold-scope",
      surface: "list",
      targetHref: "/c/me",
      rail: { kind: "target", view: "dm" },
      sidebar: { kind: "me-skeleton" },
      main: { kind: "target-skeleton", href: "/c/me" },
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        ShellFrameView,
        {
          breakpoint: "desktop",
          checkpoint,
          sidebar,
          cancelPendingNavigation: vi.fn(),
          rail,
          profile,
          inbox,
        },
        createElement("old-main"),
      ), { createNodeMock: () => ({ offsetWidth: 240 }) })
    })

    expect(sidebar).not.toHaveBeenCalled()
    expect(renderer.root.findAllByType("old-sidebar")).toHaveLength(0)
    expect(renderer.root.findAllByType("old-main")).toHaveLength(0)
    expect(renderer.root.findAllByType("dm-sidebar-skeleton")).toHaveLength(1)
    expect(renderer.root.findByType("channel-loading-frame").props.href).toBe("/c/me")
  })
})
