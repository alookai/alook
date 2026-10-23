import { createElement, Fragment, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SortableServer } from "./sortable-server"
import { tid } from "@/lib/community/testids"
import { act, fireEvent, render, setupUser } from "@/test/react-dom-harness"

const feedback = vi.hoisted(() => ({ tooltip: vi.fn() }))

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
  ContextMenuTrigger: ({ render }: { render: ReactNode }) =>
    createElement("context-menu-trigger", null, render),
  ContextMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("context-menu-content", null, children),
  ContextMenuItem: ({ children }: { children: ReactNode }) =>
    createElement("context-menu-item", null, children),
  ContextMenuSeparator: () => null,
}))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children, ...props }: { children: ReactNode }) => { feedback.tooltip(props); return createElement(Fragment, null, children) },
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}))
vi.mock("@/components/ui/confirm-dialog", () => ({ ConfirmDialog: () => null }))
vi.mock("@/components/ui/number-ticker", () => ({ NumberTicker: () => null }))
vi.mock("@/components/avatar", () => ({ SeededBackdrop: () => null }))

const server = {
  id: "a",
  name: "A",
  initial: "A",
  active: false,
  mentions: 0,
}

function renderServer(
  active = false,
  mentions = 0,
  official = false,
  extraProps: Record<string, unknown> = {},
) {
  const renderer = render(createElement(SortableServer, {
    server: { ...server, mentions, official },
    active,
    onClick: vi.fn(),
    dragDescriptionId: "rail-help",
    ...extraProps,
  }))
  const button = () => renderer.container.querySelector<HTMLAnchorElement>("a")!
  const activationRoot = () => button().closest("div.group") as HTMLDivElement
  return { ...renderer, button, activationRoot }
}

describe("SortableServer stable menu trigger", () => {
  afterEach(() => vi.restoreAllMocks())

  it("previews the final target/source folder thumbnails and restores the same target anchor", () => {
    const props = { server: { ...server, unread: true, mentions: 3 }, active: true, onClick: vi.fn() }
    const source = { ...server, id: "b", name: "Bee", initial: "B", unread: false }
    const result = render(createElement(SortableServer, { ...props, preview: "combine", combineWith: source }))
    const anchor = result.getByTestId(tid.serverIcon("a"))
    const preview = result.container.querySelector('[data-slot="community-server-rail-combine-preview"]')!
    expect([...preview.querySelectorAll('[role="img"]')].map((node) => node.getAttribute("aria-label"))).toEqual(["A", "Bee"])
    expect(preview).toHaveClass("size-12", "ring-primary")
    expect(result.container.querySelector(`[data-testid="${tid.railUnreadBadge("a")}"]`)).toBeNull()
    result.rerender(createElement(SortableServer, props))
    expect(result.getByTestId(tid.serverIcon("a"))).toBe(anchor)
    expect(result.container.querySelector('[data-slot="community-server-rail-combine-preview"]')).toBeNull()
    expect(result.container.querySelectorAll('[role="img"]')).toHaveLength(1)
    expect(result.getByTestId(tid.railUnreadBadge("a"))).toBeInTheDocument()
  })

  it("hides the dragged base tooltip and bar, and changes target feedback on the same anchor", () => {
    const props = { server: { ...server, unread: true }, active: true, onClick: vi.fn() }
    const result = render(createElement(SortableServer, { ...props, dragging: true, preview: "combine" }))
    const anchor = result.getByTestId(tid.serverIcon("a"))
    expect(feedback.tooltip).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }))
    expect(result.getByTestId(tid.serverRailIndicator("a"))).toHaveClass("h-0", "opacity-0")
    expect(result.container.querySelector('[data-rail-preview="combine"] .ring-primary')).not.toBeNull()
    result.rerender(createElement(SortableServer, { ...props, dragging: false, preview: "reorder-after" }))
    expect(result.getByTestId(tid.serverIcon("a"))).toBe(anchor)
    expect(result.getByTestId(tid.serverRailIndicator("a"))).toHaveClass("h-8")
    expect(result.container.querySelector('[data-slot="community-server-rail-insert"]')).toHaveClass("-bottom-1")
    result.rerender(createElement(SortableServer, props))
    expect(result.container.querySelector('[data-rail-preview]')).toBeNull()
    expect(result.container.querySelector('[data-slot="community-server-rail-insert"]')).toBeNull()
    expect(feedback.tooltip).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }))
  })

  it("updates href on the same anchor with the committed activation dispatcher", async () => {
    const current = { activate: vi.fn() }
    const dispatch = () => current.activate()
    const props = { server, onClick: dispatch, href: "/c/channels/a/first" }
    const result = render(createElement(SortableServer, props))
    const anchor = result.getByTestId(tid.serverIcon("a"))
    const originalActivate = current.activate
    current.activate = vi.fn()
    result.rerender(createElement(SortableServer, { ...props, href: "/c/channels/a/latest" }))
    expect(result.getByTestId(tid.serverIcon("a"))).toBe(anchor)
    expect(anchor).toHaveAttribute("href", "/c/channels/a/latest")
    await setupUser().click(anchor)
    expect(originalActivate).not.toHaveBeenCalled()
    expect(current.activate).toHaveBeenCalledTimes(1)
  })

  it("announces official status without changing ordinary server labels", () => {
    const ordinary = renderServer()
    expect(ordinary.button()).toHaveAccessibleName("A")
    const official = renderServer(false, 0, true)
    expect(official.button()).toHaveAccessibleName("A, Official server")
  })

  it("keeps the exact icon button focused when first focus activates menu content", () => {
    const result = renderServer()
    const originalButton = result.button()

    expect(result.container.querySelectorAll("context-menu-trigger")).toHaveLength(1)
    expect(result.container.querySelectorAll("context-menu-content")).toHaveLength(0)
    act(() => originalButton.focus())

    expect(result.button()).toBe(originalButton)
    expect(document.activeElement).toBe(originalButton)
    expect(result.container.querySelectorAll("context-menu-trigger")).toHaveLength(1)
    expect(result.container.querySelectorAll("context-menu-content")).toHaveLength(1)
  })

  it("keeps the same button when pointer hover activates the menu", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const onClick = vi.fn()
    const result = renderServer(false, 0, false, { onClick })
    const originalButton = result.button()

    fireEvent.pointerEnter(result.activationRoot())

    expect(result.button()).toBe(originalButton)
    expect(onClick).not.toHaveBeenCalled()
    expect(result.container.querySelectorAll("context-menu-trigger")).toHaveLength(1)
    expect(result.container.querySelectorAll("context-menu-content")).toHaveLength(1)
    expect(focus).not.toHaveBeenCalled()
  })

  it("keeps the same button for first touch-like pointer activation", () => {
    const result = renderServer()
    const originalButton = result.button()

    fireEvent.pointerDown(originalButton, { pointerType: "touch" })

    expect(result.button()).toBe(originalButton)
    expect(originalButton.isConnected).toBe(true)
    expect(result.container.querySelectorAll("context-menu-content")).toHaveLength(1)
  })

  it("keeps drag help without advertising keyboard sorting", () => {
    const result = renderServer()
    const button = result.button()
    expect(button).toHaveAttribute("aria-describedby", "rail-help")
    expect(button).not.toHaveAttribute("aria-keyshortcuts")
    fireEvent.keyDown(button, { key: "F10", shiftKey: true })
    expect(result.container.querySelectorAll("context-menu-content")).toHaveLength(1)
    const menuText = result.container.textContent
    expect(menuText).not.toContain("Move…")
    expect(menuText).not.toContain("Create group")
  })

  it("keeps active and inactive cursor state on the actual button", () => {
    const active = renderServer(true)
    const inactive = renderServer(false)

    expect(active.button()).toHaveClass("cursor-default")
    expect(inactive.button()).toHaveClass("cursor-pointer")
  })

  it("dispatches both pointer click and Enter through the inactive Server action", async () => {
    const onClick = vi.fn()
    const result = renderServer(false, 0, false, { onClick })
    const user = setupUser()

    await user.click(result.button())
    result.button().focus()
    await user.keyboard("{Enter}")

    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it("stacks the numeric mention badge above the icon without changing its presentation", () => {
    const result = renderServer(false, 12)

    const button = result.button()
    const badge = result.getByTestId(tid.railUnreadBadge("a"))
    const dragPreview = result.container.querySelector<HTMLElement>("[data-rail-drag-preview]")!
    expect(button).toHaveClass("z-1")
    expect(badge).toHaveClass("z-2", "bg-primary", "min-w-5", "px-1")
    expect(dragPreview).toHaveClass("size-10")
    expect(dragPreview.querySelectorAll(`[data-testid="${tid.railUnreadBadge("a")}"]`))
      .toHaveLength(0)
  })
})

vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))
