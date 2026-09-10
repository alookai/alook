import { createElement, useEffect, useState, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { ShellFrameView } from "./shell-frame-view"
import type { CommunityCheckpointPlan, CommunitySurface } from "@/lib/community/community-route"

const mocks = vi.hoisted(() => ({
  onLayoutChanged: vi.fn(),
  defaultLayout: { current: { sidebar: 24, main: 76 } },
  groupProps: vi.fn(),
  panelProps: vi.fn(),
  railProps: vi.fn(),
  overlayProps: vi.fn(),
  pendingProps: vi.fn(),
  channelSkeletonProps: vi.fn(),
}))

vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({
    defaultLayout: mocks.defaultLayout.current,
    onLayoutChanged: mocks.onLayoutChanged,
  }),
}))
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children, ...props }: Record<string, unknown>) => {
    mocks.groupProps(props)
    return createElement("div", { "data-panel-group": "", className: props.className }, children as ReactNode)
  },
  ResizablePanel: ({ children, ...props }: Record<string, unknown>) => {
    mocks.panelProps(props)
    return createElement("div", {
      "data-slot": "resizable-panel",
      "data-testid": props.id,
      "data-mobile-active": props["data-mobile-active"],
      "data-mobile-hidden": props["data-mobile-hidden"],
      hidden: props.hidden,
      className: props.className,
    }, children as ReactNode)
  },
  ResizableHandle: (props: Record<string, unknown>) => createElement("div", { "data-panel-handle": "", className: props.className }),
}))
vi.mock("@/components/ui/app-surface", () => ({
  AppSurface: ({ children, ...props }: Record<string, unknown>) => createElement("div", { ...props, "data-app-surface": "" }, children as ReactNode),
}))
vi.mock("./shell", () => ({
  Shell: ({ children, onNavigationIntent: _onNavigationIntent, ...props }: Record<string, unknown>) => createElement("div", { ...props, "data-shell-root": "" }, children as ReactNode),
}))
vi.mock("./server-rail", () => ({
  ServerRail: (props: Record<string, unknown>) => {
    mocks.railProps(props)
    return createElement("div", { "data-server-rail": "" })
  },
}))
vi.mock("./user-bar", () => ({
  UserBar: () => createElement("div", { "data-user-bar": "" }),
}))
vi.mock("./community-inbox-popover", () => ({
  InboxPopover: () => createElement("div", { "data-inbox-popover": "" }),
}))
vi.mock("./shell-frame-overlays", () => ({
  ShellFrameOverlays: (props: Record<string, unknown>) => {
    mocks.overlayProps(props)
    return createElement("div", { "data-shell-overlays": "" })
  },
}))
vi.mock("./community-pending-frame", () => ({
  CommunityPendingFrame: (props: Record<string, unknown>) => {
    mocks.pendingProps(props)
    return createElement("div", {
      "data-channel-loading-frame": "",
      "data-community-mobile-transition": "suppress",
    })
  },
}))
vi.mock("@/components/community/channels/channel-sidebar", () => ({
  ChannelSidebarSkeleton: (props: Record<string, unknown>) => {
    mocks.channelSkeletonProps(props)
    return createElement("div", { "data-channel-sidebar-skeleton": "" })
  },
}))
vi.mock("@/components/community/channels/dm-sidebar", () => ({
  DmSidebarSkeleton: () => createElement("div", { "data-dm-sidebar-skeleton": "" }),
}))

function latestProps(capture: ReturnType<typeof vi.fn>, id?: string) {
  const props = capture.mock.calls
    .toReversed()
    .map(([value]) => value as Record<string, unknown>)
    .find((value) => id === undefined || value.id === id)
  if (!props) throw new Error(`Expected captured props${id ? ` for ${id}` : ""}`)
  return props
}

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
const extensionProps = {
  userBarExtension: { active: "none", update: null },
  daemonUpdate: { update: null, eligibleMachines: [], request: vi.fn() },
  onUserBarInboxOpenChange: vi.fn(),
  onUserBarOpenProfile: vi.fn(),
  onUserBarOpenUpdate: vi.fn(),
  dismissUserBarExtension: vi.fn(),
} as never

let animateDescriptor: PropertyDescriptor | undefined

describe("ShellFrameView", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    mocks.groupProps.mockClear()
    mocks.panelProps.mockClear()
    mocks.railProps.mockClear()
    mocks.overlayProps.mockClear()
    mocks.pendingProps.mockClear()
    mocks.channelSkeletonProps.mockClear()
    mocks.defaultLayout.current = { sidebar: 24, main: 76 }
    animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate")
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })))
  })

  afterEach(() => {
    if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, "animate", animateDescriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).animate
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("keeps responsive detail shell zones while the breakpoint is unknown", async () => {
    const renderer = render(createElement(ShellFrameView, {
      ...extensionProps,
      breakpoint: "unknown",
      checkpoint: committedCheckpoint("/c/me/dm_1", "detail"),
      sidebar: () => createElement("sidebar-content"),
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }, createElement("main-content")))
    expect(renderer.container.querySelectorAll("[data-channel-loading-frame]")).toHaveLength(1)
    expect(latestProps(mocks.pendingProps)).toMatchObject({
      href: "/c/me/dm_1",
      reserveBackSlot: true,
    })
    const initialRailWrapper = renderer.container.querySelector('[class*="hidden sm:contents"]')!
    expect(initialRailWrapper.className).toContain("min-h-0")
    expect(renderer.container.querySelectorAll("sidebar-content")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-user-bar]")).toHaveLength(1)
    expect(renderer.container.querySelector('[data-slot="community-user-bar-overlay"]')?.className)
      .toContain("max-sm:hidden")
    expect(renderer.container.querySelectorAll("main-content")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("[data-shell-overlays]")).toHaveLength(0)
    expect(latestProps(mocks.panelProps, "sidebar")["data-mobile-hidden"]).toBe(true)
    expect(latestProps(mocks.panelProps, "main")["data-mobile-active"]).toBe(true)
    const initialGroup = latestProps(mocks.groupProps)
    expect(initialGroup.className).toContain(
      "max-sm:*:data-[mobile-active=true]:flex-1!",
    )
    expect(initialGroup.className).toContain(
      "max-sm:*:data-[mobile-hidden=true]:hidden!",
    )
  })

  it("keeps rail, sidebar, and UserBar in the unknown list shell", async () => {
    const renderer = render(createElement(ShellFrameView, {
      ...extensionProps,
      breakpoint: "unknown",
      checkpoint: committedCheckpoint("/c/me", "list"),
      sidebar: () => createElement("sidebar-content"),
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }, createElement("main-content")))
    expect(renderer.container.querySelectorAll("[data-server-rail]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("sidebar-content")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-user-bar]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-channel-loading-frame]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("main-content")).toHaveLength(0)
    expect(latestProps(mocks.panelProps, "sidebar")["data-mobile-active"]).toBe(true)
    expect(latestProps(mocks.panelProps, "main")["data-mobile-hidden"]).toBe(true)
  })

  it("keeps the desktop panel geometry, order, and seeded overlay call", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    const renderer = render(createElement(ShellFrameView, {
      ...extensionProps,
      breakpoint: "desktop",
      checkpoint: committedCheckpoint("/c/channels/s1/c1", "detail"),
      sidebar,
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
      extraDialogs: createElement("extra-dialog"),
    }, createElement("main-content")))

    const shell = renderer.container.querySelector("[data-shell-root]")!
    const hostTypes = [...shell.querySelectorAll("*")].map((node) => (
      node.hasAttribute("data-server-rail") ? "server-rail"
        : node.hasAttribute("data-app-surface") ? "app-surface"
        : node.hasAttribute("data-user-bar") ? "user-bar"
        : node.hasAttribute("data-shell-overlays") ? "shell-overlays" : node.tagName
    ))
    expect(hostTypes.indexOf("server-rail")).toBeLessThan(hostTypes.indexOf("app-surface"))
    expect(hostTypes.indexOf("app-surface")).toBeLessThan(hostTypes.indexOf("user-bar"))
    expect(hostTypes.indexOf("user-bar")).toBeLessThan(hostTypes.indexOf("shell-overlays"))
    expect(renderer.container.querySelectorAll("[data-shell-overlays]")).toHaveLength(1)
    expect(latestProps(mocks.railProps).bottomInset).toBe(60)
    expect(renderer.container.querySelectorAll('[class="flex min-h-0"]')).toHaveLength(1)
    const group = latestProps(mocks.groupProps)
    expect(group.id).toBe("community-shell")
    expect(group.orientation).toBe("horizontal")
    expect(group.disabled).toBe(false)
    const sidebarPanel = latestProps(mocks.panelProps, "sidebar")
    const mainPanel = latestProps(mocks.panelProps, "main")
    expect(sidebarPanel).toMatchObject({ id: "sidebar", defaultSize: "24%", minSize: 160, maxSize: 360 })
    expect(sidebarPanel.className).toContain("pb-15")
    expect(mainPanel).toMatchObject({ id: "main", defaultSize: "76%" })
    expect("profileStatusSeeds" in latestProps(mocks.overlayProps)).toBe(false)
    expect(sidebar).toHaveBeenCalledWith()
    const userBarOverlay = renderer.container.querySelector<HTMLElement>(
      '[data-slot="community-user-bar-overlay"]',
    )!
    const userBarUnderlay = userBarOverlay.querySelector<HTMLElement>(
      '[data-slot="community-user-bar-underlay"]',
    )!
    expect(userBarUnderlay).toHaveAttribute("aria-hidden", "true")
    expect(userBarUnderlay.className.split(" ")).toEqual(expect.arrayContaining([
      "pointer-events-none",
      "absolute",
      "inset-x-0",
      "bottom-0",
      "-z-10",
      "bg-linear-to-t",
      "from-(--app-bg)",
      "to-transparent",
    ]))
    expect(userBarUnderlay.style.height).toBe(
      "calc(60px + var(--app-safe-area-bottom))",
    )
    expect(userBarOverlay.style.getPropertyValue("--community-desktop-user-bar-width")).toBe(
      "calc(clamp(160px, calc(24% - 0.48px), 360px) + 58px)",
    )
    await act(async () => {
      const onResize = latestProps(mocks.panelProps, "sidebar").onResize as (
        size: { asPercentage: number; inPixels: number },
      ) => void
      onResize({ asPercentage: 30, inPixels: 300 })
    })
    expect(userBarOverlay.style.getPropertyValue("--community-desktop-user-bar-width"))
      .toBe("358px")

    const renderedSidebar = renderer.container.querySelector<HTMLElement>(
      '[data-slot="resizable-panel"][data-testid="sidebar"] > div',
    )!
    vi.spyOn(renderedSidebar, "getBoundingClientRect").mockReturnValue({
      ...renderedSidebar.getBoundingClientRect(),
      width: 299.25,
    })
    await act(async () => {
      const onResize = latestProps(mocks.panelProps, "sidebar").onResize as (
        size: { asPercentage: number; inPixels: number },
      ) => void
      onResize({ asPercentage: 30, inPixels: 300 })
    })
    expect(userBarOverlay.style.getPropertyValue("--community-desktop-user-bar-width"))
      .toBe("357.25px")

    renderer.unmount()
  })

  it("seeds the User bar from the persisted panel percentage before pixel sizing", () => {
    mocks.defaultLayout.current = { sidebar: 18.75, main: 81.25 }
    const renderer = render(createElement(ShellFrameView, {
      ...extensionProps,
      breakpoint: "desktop",
      checkpoint: committedCheckpoint("/c/me", "list"),
      sidebar: () => createElement("sidebar-content"),
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }, createElement("main-content")))

    const group = latestProps(mocks.groupProps)
    expect(group.defaultLayout).toEqual({ sidebar: 18.75, main: 81.25 })
    expect(renderer.container.querySelector<HTMLElement>(
      '[data-slot="community-user-bar-overlay"]',
    )!.style.getPropertyValue("--community-desktop-user-bar-width")).toBe(
      "calc(clamp(160px, calc(18.75% - 0.375px), 360px) + 58px)",
    )
  })

  it("composes the server-root list surface with desktop rail, sidebar, and landing content", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    const renderer = render(createElement(ShellFrameView, {
      ...extensionProps,
      breakpoint: "desktop",
      checkpoint: committedCheckpoint("/c/channels/s1", "list"),
      sidebar,
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }, createElement("main-content")))

    expect(renderer.container.querySelectorAll("[data-server-rail]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll('[class="flex min-h-0"]')).toHaveLength(1)
    expect(renderer.container.querySelectorAll("sidebar-content")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("main-content")).toHaveLength(1)
    expect(sidebar).toHaveBeenCalledWith()

    renderer.unmount()
  })

  it("keeps one responsive skeleton while mobile nav and detail geometry stay distinct", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    const renderer = render(createElement(ShellFrameView, {
      ...extensionProps,
      breakpoint: "mobile",
      checkpoint: committedCheckpoint("/c/me", "list"),
      sidebar,
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }, createElement("main-content")))
    expect(renderer.container.querySelectorAll("[data-server-rail]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-user-bar]")).toHaveLength(1)
    const mobileSidebarPanel = latestProps(mocks.panelProps, "sidebar")
    expect(mobileSidebarPanel.id).toBe("sidebar")
    expect(latestProps(mocks.panelProps, "main").id).toBe("main")
    expect(mobileSidebarPanel.className).toContain("pb-15")
    const mobileUserBarOverlay = renderer.container.querySelector<HTMLElement>(
      '[data-slot="community-user-bar-overlay"]',
    )!
    expect(mobileUserBarOverlay.querySelectorAll(
      '[data-slot="community-user-bar-underlay"]',
    )).toHaveLength(1)
    expect(mobileUserBarOverlay.style.width).toBe("calc(100% + 56px)")
    expect(mobileUserBarOverlay.style.marginLeft).toBe("-56px")
    const mobileSurface = renderer.container.querySelector("[data-app-surface]")!
    expect(mobileSurface.className).toContain("rounded-tl-xl")
    expect(mobileSurface.className).toContain("border-l")
    expect(mobileSurface.className).toContain("border-t")
    expect(renderer.container.querySelectorAll("main-content")).toHaveLength(1)
    expect(mobileSidebarPanel.hidden).toBe(false)
    expect(latestProps(mocks.panelProps, "main").hidden).toBe(true)
    expect(mobileSidebarPanel["data-mobile-active"]).toBe(true)
    expect(mobileSidebarPanel["data-mobile-hidden"]).toBeUndefined()
    expect(latestProps(mocks.panelProps, "main")["data-mobile-active"]).toBeUndefined()
    expect(latestProps(mocks.panelProps, "main")["data-mobile-hidden"]).toBe(true)
    expect(latestProps(mocks.groupProps).disabled).toBe(true)
    expect(latestProps(mocks.groupProps).className).toContain(
      "max-sm:*:data-[mobile-active=true]:flex-1!",
    )
    expect(renderer.container.querySelectorAll("[data-shell-overlays]")).toHaveLength(1)
    const listMotion = renderer.container.querySelector('[data-community-mobile-surface="list"]')!
    expect(listMotion.className).toContain("flex")
    expect("profileStatusSeeds" in latestProps(mocks.overlayProps)).toBe(false)
    expect(sidebar).toHaveBeenCalledWith({ noHeader: false })

    renderer.rerender(createElement(ShellFrameView, {
      ...extensionProps,
      breakpoint: "mobile",
      checkpoint: committedCheckpoint("/c/me/dm_1", "detail"),
      sidebar,
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }, createElement("main-content")))
    expect(renderer.container.querySelectorAll("[data-server-rail]")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("[data-user-bar]")).toHaveLength(0)
    expect(renderer.container.querySelectorAll('[data-slot="community-user-bar-overlay"]')).toHaveLength(0)
    expect(renderer.container.querySelectorAll('[data-slot="community-user-bar-underlay"]')).toHaveLength(0)
    expect(renderer.container.querySelectorAll("[data-app-surface]")).toHaveLength(1)
    expect(renderer.container.querySelector("[data-app-surface]")?.className).toContain("rounded-none")
    expect(renderer.container.querySelectorAll("main-content")).toHaveLength(1)
    expect(latestProps(mocks.panelProps, "sidebar").hidden).toBe(true)
    expect(latestProps(mocks.panelProps, "main").hidden).toBe(false)
    expect(latestProps(mocks.panelProps, "sidebar")["data-mobile-active"]).toBeUndefined()
    expect(latestProps(mocks.panelProps, "sidebar")["data-mobile-hidden"]).toBe(true)
    expect(latestProps(mocks.panelProps, "main")["data-mobile-active"]).toBe(true)
    expect(latestProps(mocks.panelProps, "main")["data-mobile-hidden"]).toBeUndefined()
    expect(renderer.container.querySelectorAll("[data-shell-overlays]")).toHaveLength(1)
    const detailMotion = renderer.container.querySelector('[data-community-mobile-surface="detail"]')!
    expect(detailMotion.className).toContain("flex")
  })

  it("starts both committed mobile switch directions before passive effects and skips reduced motion", async () => {
    const cancel = vi.fn()
    const effectOrder: string[] = []
    const animate = vi.fn(() => {
      effectOrder.push("animate")
      return { cancel }
    })
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    })
    function PassiveFrameProbe({ href }: { href: string }) {
      useEffect(() => { effectOrder.push(`passive:${href}`) }, [href])
      return createElement("main-content")
    }
    let sidebarMounts = 0
    function StatefulSidebar() {
      const [identity] = useState(() => ++sidebarMounts)
      return createElement(
        "div",
        { "data-testid": "community-channel-sidebar-scroll" },
        createElement("div", { "data-testid": "sidebar-dnd-owner", "data-identity": identity }),
      )
    }
    const sidebar = () => createElement(StatefulSidebar)
    const common = {
      ...extensionProps,
      breakpoint: "mobile" as const,
      sidebar,
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }
    const renderer = render(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c1", "detail") },
      createElement(PassiveFrameProbe, { href: "/c/channels/s1/c1" }),
    ))
    expect(animate).not.toHaveBeenCalled()
    const sidebarPanel = renderer.container.querySelector<HTMLElement>('[data-testid="sidebar"]')!
    const mainPanel = renderer.container.querySelector<HTMLElement>('[data-testid="main"]')!
    const sidebarScroll = renderer.container.querySelector<HTMLElement>(
      '[data-testid="community-channel-sidebar-scroll"]',
    )!
    const dndOwner = renderer.container.querySelector<HTMLElement>('[data-testid="sidebar-dnd-owner"]')!
    sidebarScroll.scrollTop = 37
    dndOwner.dataset.owner = "stable"
    effectOrder.length = 0

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1", "list") },
      createElement(PassiveFrameProbe, { href: "/c/channels/s1" }),
    ))
    expect(animate).toHaveBeenCalledOnce()
    expect(animate).toHaveBeenLastCalledWith([
      { opacity: 0.92, transform: "translate3d(-8px, 0, 0)" },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], {
      duration: 180,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    })
    expect(effectOrder).toEqual(["animate", "passive:/c/channels/s1"])
    expect(renderer.container.querySelector('[data-testid="sidebar"]')).toBe(sidebarPanel)
    expect(renderer.container.querySelector('[data-testid="main"]')).toBe(mainPanel)
    expect(renderer.container.querySelector('[data-testid="community-channel-sidebar-scroll"]'))
      .toBe(sidebarScroll)
    expect(renderer.container.querySelector('[data-testid="sidebar-dnd-owner"]')).toBe(dndOwner)
    expect(sidebarScroll.scrollTop).toBe(37)
    expect(dndOwner.dataset.owner).toBe("stable")

    effectOrder.length = 0
    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c2", "detail") },
      createElement(PassiveFrameProbe, { href: "/c/channels/s1/c2" }),
    ))
    expect(animate).toHaveBeenCalledTimes(2)
    expect(animate).toHaveBeenLastCalledWith([
      { opacity: 0.92, transform: "translate3d(8px, 0, 0)" },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], {
      duration: 180,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    })
    expect(effectOrder).toEqual(["animate", "passive:/c/channels/s1/c2"])
    expect(renderer.container.querySelector('[data-testid="sidebar"]')).toBe(sidebarPanel)
    expect(renderer.container.querySelector('[data-testid="main"]')).toBe(mainPanel)
    expect(renderer.container.querySelector('[data-testid="community-channel-sidebar-scroll"]'))
      .toBe(sidebarScroll)
    expect(renderer.container.querySelector('[data-testid="sidebar-dnd-owner"]')).toBe(dndOwner)
    expect(sidebarScroll.scrollTop).toBe(37)
    expect(dndOwner.dataset.owner).toBe("stable")
    expect(sidebarMounts).toBe(1)

    effectOrder.length = 0
    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c3", "detail") },
      createElement(PassiveFrameProbe, { href: "/c/channels/s1/c3" }),
    ))
    expect(animate).toHaveBeenCalledTimes(3)
    expect(animate).toHaveBeenLastCalledWith([
      { opacity: 0.92, transform: "translate3d(8px, 0, 0)" },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], {
      duration: 180,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    })
    expect(effectOrder).toEqual(["animate", "passive:/c/channels/s1/c3"])

    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })))
    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c4", "detail") },
      createElement(PassiveFrameProbe, { href: "/c/channels/s1/c4" }),
    ))
    expect(animate).toHaveBeenCalledTimes(3)
  })

  it("animates successful pending commits and consumes canceled stale targets", async () => {
    const cancel = vi.fn()
    const animate = vi.fn(() => ({ cancel }))
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    })
    const common = {
      ...extensionProps,
      breakpoint: "mobile" as const,
      sidebar: () => createElement("sidebar-content"),
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }
    const renderer = render(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1", "list") },
      createElement("main-content"),
    ))

    renderer.rerender(createElement(
      ShellFrameView,
      {
        ...common,
        checkpoint: {
          mode: "same-scope-leaf",
          surface: "detail",
          targetHref: "/c/channels/s1/c2",
          rail: { kind: "keep" },
          sidebar: { kind: "keep" },
          main: { kind: "target-skeleton", href: "/c/channels/s1/c2" },
        },
      },
      createElement("main-content"),
    ))
    expect(animate).not.toHaveBeenCalled()
    expect(renderer.container.querySelector('[data-community-mobile-transition="suppress"]'))
      .not.toBeNull()

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c2", "detail") },
      createElement("main-content"),
    ))
    expect(animate).toHaveBeenCalledOnce()
    expect(animate).toHaveBeenLastCalledWith([
      { opacity: 0.92, transform: "translate3d(8px, 0, 0)" },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], {
      duration: 180,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    })

    renderer.rerender(createElement(
      ShellFrameView,
      {
        ...common,
        checkpoint: {
          mode: "same-scope-leaf",
          surface: "list",
          targetHref: "/c/channels/s1",
          rail: { kind: "keep" },
          sidebar: { kind: "keep" },
          main: { kind: "keep" },
        },
      },
      createElement("main-content"),
    ))
    expect(animate).toHaveBeenCalledOnce()

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1", "list") },
      createElement("main-content"),
    ))
    expect(animate).toHaveBeenCalledTimes(2)
    expect(animate).toHaveBeenLastCalledWith([
      { opacity: 0.92, transform: "translate3d(-8px, 0, 0)" },
      { opacity: 1, transform: "translate3d(0, 0, 0)" },
    ], {
      duration: 180,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    })

    renderer.rerender(createElement(
      ShellFrameView,
      {
        ...common,
        checkpoint: {
          mode: "same-scope-leaf",
          surface: "detail",
          targetHref: "/c/channels/s1/c3",
          rail: { kind: "keep" },
          sidebar: { kind: "keep" },
          main: { kind: "target-skeleton", href: "/c/channels/s1/c3" },
        },
      },
      createElement("main-content"),
    ))
    expect(animate).toHaveBeenCalledTimes(2)

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1", "list") },
      createElement("main-content"),
    ))
    expect(animate).toHaveBeenCalledTimes(2)

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c3", "detail") },
      createElement("main-content"),
    ))
    expect(animate).toHaveBeenCalledTimes(2)

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c3", "detail") },
      createElement("main-content"),
    ))
    expect(animate).toHaveBeenCalledTimes(2)
  })

  it("consumes a committed mobile target whose content suppresses entry motion", async () => {
    const cancel = vi.fn()
    const animate = vi.fn(() => ({ cancel }))
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    })
    const common = {
      ...extensionProps,
      breakpoint: "mobile" as const,
      sidebar: () => createElement("sidebar-content"),
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }
    const renderer = render(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c1", "detail") },
      createElement("main-content"),
    ))

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c2", "detail") },
      createElement("main-content", { "data-community-mobile-transition": "suppress" }),
    ))
    expect(animate).not.toHaveBeenCalled()

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, checkpoint: committedCheckpoint("/c/channels/s1/c2", "detail") },
      createElement("main-content"),
    ))
    expect(animate).not.toHaveBeenCalled()
  })

  it("preserves child component identity across the 639 to 640 breakpoint", async () => {
    let mounts = 0
    function StatefulMain() {
      const [identity] = useState(() => ++mounts)
      return createElement("div", { "data-stateful-main": "", "data-identity": identity })
    }
    const common = {
      ...extensionProps,
      checkpoint: committedCheckpoint("/c/me/dm_1", "detail"),
      sidebar: () => createElement("sidebar-content"),
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }
    const renderer = render(createElement(
      ShellFrameView,
      { ...common, breakpoint: "mobile" },
      createElement(StatefulMain),
    ))
    expect(renderer.container.querySelector("[data-stateful-main]")
      ?.getAttribute("data-identity")).toBe("1")

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, breakpoint: "desktop" },
      createElement(StatefulMain),
    ))
    expect(renderer.container.querySelector("[data-stateful-main]")
      ?.getAttribute("data-identity")).toBe("1")
    expect(mounts).toBe(1)
  })

  it("keeps one panel-owned resize callback across breakpoint changes", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    const common = {
      ...extensionProps,
      checkpoint: committedCheckpoint("/c/me", "list"),
      sidebar,
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }
    const renderer = render(
      createElement(ShellFrameView, { ...common, breakpoint: "desktop" }, createElement("main-content")),
    )
    const onResize = latestProps(mocks.panelProps, "sidebar").onResize
    expect(onResize).toBeTypeOf("function")

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, breakpoint: "mobile" },
      createElement("main-content"),
    ))
    expect(latestProps(mocks.panelProps, "sidebar").onResize).toBe(onResize)

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, breakpoint: "desktop" },
      createElement("main-content"),
    ))
    expect(latestProps(mocks.panelProps, "sidebar").onResize).toBe(onResize)

    renderer.unmount()
  })

  it("keeps committed content mounted while same-scope navigation is pending", async () => {
    const sidebar = vi.fn(() => createElement("sidebar-content"))
    const common = {
      ...extensionProps,
      sidebar,
      cancelPendingNavigation: vi.fn(),
      rail,
      profile,
      inbox,
    }
    const renderer = render(createElement(
      ShellFrameView,
      {
        ...common,
        breakpoint: "desktop",
        checkpoint: sameScopePendingCheckpoint("/c/me", "list", "/c/me/friends"),
      },
      createElement("main-content"),
    ))
    expect(renderer.container.querySelectorAll("[data-channel-loading-frame]")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("main-content")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-server-rail]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-user-bar]")).toHaveLength(1)

    renderer.rerender(createElement(
      ShellFrameView,
      {
        ...common,
        breakpoint: "mobile",
        checkpoint: sameScopePendingCheckpoint("/c/me", "list", "/c/me/friends"),
      },
      createElement("main-content"),
    ))
    expect(renderer.container.querySelectorAll("[data-channel-loading-frame]")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("[data-server-rail]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("sidebar-content")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-user-bar]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("main-content")).toHaveLength(1)
  })

  it("replaces the committed sidebar with one target-scoped cold server checkpoint", async () => {
    const sidebar = vi.fn(() => createElement("old-sidebar"))
    const common = {
      ...extensionProps,
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
    const renderer = render(createElement(
      ShellFrameView,
      { ...common, breakpoint: "desktop" },
      createElement("old-main"),
    ))

    expect(sidebar).not.toHaveBeenCalled()
    expect(renderer.container.querySelectorAll("old-sidebar")).toHaveLength(0)
    expect(latestProps(mocks.channelSkeletonProps).targetServerId).toBe("s2")
    expect(latestProps(mocks.pendingProps).href).toBe("/c/channels/s2")

    renderer.rerender(createElement(
      ShellFrameView,
      { ...common, breakpoint: "mobile" },
      createElement("old-main"),
    ))
    expect(latestProps(mocks.panelProps, "sidebar")["data-mobile-active"]).toBe(true)
    expect(renderer.container.querySelector('[data-testid="sidebar"]')
      ?.querySelectorAll("[data-channel-sidebar-skeleton]")).toHaveLength(1)
    expect(latestProps(mocks.panelProps, "main").hidden).toBe(true)
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
    const renderer = render(createElement(
      ShellFrameView,
      {
        ...extensionProps,
        breakpoint: "desktop",
        checkpoint,
        sidebar,
        cancelPendingNavigation: vi.fn(),
        rail,
        profile,
        inbox,
      },
      createElement("old-main"),
    ))

    expect(sidebar).not.toHaveBeenCalled()
    expect(renderer.container.querySelectorAll("old-sidebar")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("old-main")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("[data-dm-sidebar-skeleton]")).toHaveLength(1)
    expect(latestProps(mocks.pendingProps).href).toBe("/c/me")
  })
})
