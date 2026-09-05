import { createElement } from "react"
// @ts-expect-error react-test-renderer intentionally has no local declaration package.
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => createElement("skeleton", props),
}))
vi.mock("@/components/ui/app-surface", () => ({
  AppSurface: (props: Record<string, unknown>) => createElement("app-surface", props),
}))
vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({ defaultLayout: { sidebar: 24, main: 76 }, onLayoutChanged: vi.fn() }),
}))
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: (props: Record<string, unknown>) => createElement("panel-group", props),
  ResizablePanel: (props: Record<string, unknown>) => createElement("panel", props),
  ResizableHandle: (props: Record<string, unknown>) => createElement("panel-handle", props),
}))
vi.mock("@/hooks/use-mobile", () => ({
  useBreakpoint: () => "unknown",
}))
vi.mock("@/components/community/channels/channel-sidebar", () => ({
  ChannelSidebarSkeleton: (props: Record<string, unknown>) => createElement("server-sidebar", props),
}))
vi.mock("@/components/community/channels/dm-sidebar", () => ({
  DmSidebarSkeleton: (props: Record<string, unknown>) => createElement("me-sidebar", props),
}))
vi.mock("./server-rail", () => ({
  ServerRailPending: (props: Record<string, unknown>) => createElement(
    "rail-skeleton",
    props,
    createElement("skeleton"),
    createElement("skeleton"),
  ),
}))
vi.mock("./shell", () => ({
  Shell: (props: Record<string, unknown>) => createElement("shell-root", props),
}))
vi.mock("./user-bar", () => ({
  UserBarSkeleton: (props: Record<string, unknown>) => createElement("user-bar-skeleton", props),
}))
vi.mock("./community-pending-frame", () => ({
  CommunityPendingFrame: (props: Record<string, unknown>) => createElement("pending-main", props),
}))

import { CommunitySessionPendingFrame } from "./community-session-pending-frame"

describe("CommunitySessionPendingFrame", () => {
  function render(pathname: string) {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(CommunitySessionPendingFrame, { pathname }))
    })
    return renderer
  }

  it.each([
    ["/c/me", "me-root", "me-sidebar", "me-root"],
    ["/c/me/dm_1", "dm-detail", "me-sidebar", "dm"],
    ["/c/channels/s1", "server-root", "server-sidebar", "server-landing"],
    ["/c/channels/s1/c1", "server-detail", "server-sidebar", "server-conversation"],
  ])("renders only route-owned modules for %s", (pathname, route, sidebar, main) => {
    const renderer = render(pathname)
    const frame = renderer.root.findByProps({ "aria-label": "Loading community" })
    expect(frame.props["aria-busy"]).toBe("true")
    expect(frame.props["data-community-route-kind"]).toBe(route)
    expect(renderer.root.findAllByType("rail-skeleton")).toHaveLength(1)
    expect(renderer.root.findAllByType(sidebar)).toHaveLength(1)
    expect(renderer.root.findByType("pending-main").props.plan.main.kind).toBe(main)
    expect(renderer.root.findAllByType("pending-main")).toHaveLength(1)
    expect(renderer.root.findAllByType("user-bar-skeleton")).toHaveLength(1)
    expect(renderer.root.findAllByType("skeleton").length).toBeGreaterThanOrEqual(2)
    expect(renderer.root.findAllByType("button")).toEqual([])
    expect(renderer.root.findAllByType("a")).toEqual([])
  })

  it("keeps invalid routes neutral instead of guessing account or server ownership", () => {
    const renderer = render(["/c/channels/s1/c1", "extra"].join("/"))
    expect(renderer.root.findAllByType("rail-skeleton")).toHaveLength(0)
    expect(renderer.root.findAllByType("me-sidebar")).toHaveLength(0)
    expect(renderer.root.findAllByType("server-sidebar")).toHaveLength(0)
    expect(renderer.root.findAllByType("user-bar-skeleton")).toHaveLength(0)
    expect(renderer.root.findByType("pending-main").props.plan.main.kind).toBe("route-resolution")
  })

  it("keeps the account-scoped community root neutral while its destination resolves", () => {
    const renderer = render("/c")
    const frame = renderer.root.findByProps({ "aria-label": "Loading community" })
    expect(frame.props["data-community-route-kind"]).toBe("community-root-redirect")
    expect(renderer.root.findAllByType("rail-skeleton")).toHaveLength(0)
    expect(renderer.root.findAllByType("me-sidebar")).toHaveLength(0)
    expect(renderer.root.findAllByType("server-sidebar")).toHaveLength(0)
    expect(renderer.root.findAllByType("user-bar-skeleton")).toHaveLength(0)
    expect(renderer.root.findAllByType("pending-main")).toHaveLength(1)
    expect(renderer.root.findByType("pending-main").props.plan.main.kind).toBe("route-resolution")
  })

  it("renders no authenticated shell modules for the public invite bypass", () => {
    const renderer = render("/c/invite/token")
    expect(renderer.root.findAllByType("rail-skeleton")).toHaveLength(0)
    expect(renderer.root.findAllByType("me-sidebar")).toHaveLength(0)
    expect(renderer.root.findAllByType("server-sidebar")).toHaveLength(0)
    expect(renderer.root.findAllByType("pending-main")).toHaveLength(0)
    expect(renderer.root.findAllByType("user-bar-skeleton")).toHaveLength(0)
  })
})
