import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => createElement("div", { "data-testid": "skeleton" }),
}))
vi.mock("@/components/ui/app-surface", () => ({
  AppSurface: ({ children }: React.PropsWithChildren) => createElement("div", null, children),
}))
vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({ defaultLayout: { sidebar: 24, main: 76 }, onLayoutChanged: vi.fn() }),
}))
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: React.PropsWithChildren) => createElement("div", null, children),
  ResizablePanel: ({ children }: React.PropsWithChildren) => createElement("div", null, children),
  ResizableHandle: () => createElement("div"),
}))
const viewport = vi.hoisted(() => ({ value: "unknown" }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => viewport.value }))
beforeEach(() => { viewport.value = "unknown" })
vi.mock("@/components/community/channels/channel-sidebar", () => ({
  ChannelSidebarSkeleton: () => createElement("div", { "data-testid": "server-sidebar" }),
}))
vi.mock("@/components/community/channels/dm-sidebar", () => ({
  DmSidebarSkeleton: () => createElement("div", { "data-testid": "me-sidebar" }),
}))
vi.mock("./server-rail", () => ({
  ServerRailPending: () => createElement(
    "div",
    { "data-testid": "rail-skeleton" },
    createElement("div", { "data-testid": "skeleton" }),
    createElement("div", { "data-testid": "skeleton" }),
  ),
}))
vi.mock("./shell", () => ({
  Shell: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    createElement("div", props, children),
}))
vi.mock("./user-bar", () => ({
  UserBarSkeleton: () => createElement("div", { "data-testid": "user-bar-skeleton" }),
}))
vi.mock("./community-pending-frame", () => ({
  CommunityPendingFrame: ({ plan }: { plan: { main: { kind: string } } }) => createElement("div", {
    "data-testid": "pending-main",
    "data-main-kind": plan.main.kind,
  }),
}))

import { CommunitySessionPendingFrame } from "./community-session-pending-frame"

function renderFrame(pathname: string) {
  return render(createElement(CommunitySessionPendingFrame, { pathname }))
}

describe("CommunitySessionPendingFrame", () => {
  it.each(["mobile", "desktop"].flatMap(viewport => ["/c", "/c/me/machines", "/c/channels/s1/c1"].map(pathname => ({ viewport, pathname }))))("shows an actionable account error at $pathname on $viewport", ({ viewport: breakpoint, pathname }) => {
    viewport.value = breakpoint
    const retry = vi.fn()
    render(createElement(CommunitySessionPendingFrame, { pathname }, createElement("div", { role: "alert" },
      "Could not check account", createElement("button", { onClick: retry }, "Retry"))))
    expect(screen.getByRole("alert")).toHaveTextContent("Could not check account")
    expect(screen.queryByTestId("pending-main")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalledOnce()
  })
  it.each([
    ["/c/me", "me-root", "me-sidebar", "me-root"],
    ["/c/me/dm_1", "dm-detail", "me-sidebar", "dm"],
    ["/c/channels/s1", "server-root", "server-sidebar", "server-landing"],
    ["/c/channels/s1/c1", "server-detail", "server-sidebar", "server-conversation"],
  ])("renders only route-owned modules for %s", (pathname, route, sidebar, main) => {
    const renderer = renderFrame(pathname)
    const frame = screen.getByLabelText("Loading community")
    expect(frame).toHaveAttribute("aria-busy", "true")
    expect(frame).toHaveAttribute("data-community-route-kind", route)
    expect(screen.getByTestId("rail-skeleton")).toBeInTheDocument()
    expect(screen.getByTestId(sidebar)).toBeInTheDocument()
    expect(screen.getByTestId("pending-main")).toHaveAttribute("data-main-kind", main)
    expect(screen.getByTestId("user-bar-skeleton")).toBeInTheDocument()
    const userBarUnderlay = renderer.container.querySelector<HTMLElement>(
      '[data-slot="community-user-bar-underlay"]',
    )!
    expect(userBarUnderlay).toHaveAttribute("aria-hidden", "true")
    expect(userBarUnderlay.className).toContain("pointer-events-none")
    expect(userBarUnderlay.className).toContain("from-(--app-bg)")
    expect(userBarUnderlay.className).toContain("to-transparent")
    expect(userBarUnderlay.style.height).toBe(
      "calc(60px + var(--app-safe-area-bottom))",
    )
    expect(renderer.container.querySelectorAll('[data-testid="skeleton"]').length)
      .toBeGreaterThanOrEqual(2)
    expect(renderer.container.querySelectorAll("button, a")).toHaveLength(0)
  })

  it("keeps invalid routes neutral instead of guessing account or server ownership", () => {
    renderFrame(["/c/channels/s1/c1", "extra"].join("/"))
    expect(screen.queryByTestId("rail-skeleton")).not.toBeInTheDocument()
    expect(screen.queryByTestId("me-sidebar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("server-sidebar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("user-bar-skeleton")).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="community-user-bar-underlay"]')).toBeNull()
    expect(screen.getByTestId("pending-main")).toHaveAttribute("data-main-kind", "route-resolution")
  })

  it("keeps the account-scoped community root neutral while its destination resolves", () => {
    renderFrame("/c")
    expect(screen.getByLabelText("Loading community"))
      .toHaveAttribute("data-community-route-kind", "community-root-redirect")
    expect(screen.queryByTestId("rail-skeleton")).not.toBeInTheDocument()
    expect(screen.queryByTestId("me-sidebar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("server-sidebar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("user-bar-skeleton")).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="community-user-bar-underlay"]')).toBeNull()
    expect(screen.getByTestId("pending-main")).toHaveAttribute("data-main-kind", "route-resolution")
  })

  it("renders no authenticated shell modules for the public invite bypass", () => {
    renderFrame("/c/invite/token")
    expect(screen.queryByTestId("rail-skeleton")).not.toBeInTheDocument()
    expect(screen.queryByTestId("me-sidebar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("server-sidebar")).not.toBeInTheDocument()
    expect(screen.queryByTestId("pending-main")).not.toBeInTheDocument()
    expect(screen.queryByTestId("user-bar-skeleton")).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="community-user-bar-underlay"]')).toBeNull()
  })
})
