import { createElement, Fragment, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SortableServer } from "./sortable-server"
import { tid } from "@/lib/community/testids"
import { fireEvent, render } from "@/test/react-dom-harness"

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
  Tooltip: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}))
vi.mock("./rail-indicator", () => ({ RailIndicator: () => null }))
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

function renderServer(active = false, mentions = 0, official = false) {
  const renderer = render(createElement(SortableServer, {
    server: { ...server, mentions, official },
    active,
    onClick: vi.fn(),
    dragDescriptionId: "rail-help",
  }))
  const button = () => renderer.container.querySelector<HTMLButtonElement>("button")!
  const activationRoot = () => button().closest("div.group") as HTMLDivElement
  return { ...renderer, button, activationRoot }
}

describe("SortableServer lazy menu focus", () => {
  afterEach(() => vi.restoreAllMocks())

  it("announces official status without changing ordinary server labels", () => {
    const ordinary = renderServer()
    expect(ordinary.button()).toHaveAccessibleName("A")
    const official = renderServer(false, 0, true)
    expect(official.button()).toHaveAccessibleName("A, Official server")
  })

  it("refocuses the icon after first focus activates and replaces its menu wrapper", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const result = renderServer()

    fireEvent.focus(result.button())

    expect(result.container.querySelectorAll("context-menu-trigger")).toHaveLength(1)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it("does not steal focus when pointer hover activates the menu", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const result = renderServer()

    fireEvent.pointerEnter(result.activationRoot())

    expect(result.container.querySelectorAll("context-menu-trigger")).toHaveLength(1)
    expect(focus).not.toHaveBeenCalled()
  })

  it("exposes keyboard drag help without positional menu shortcuts", () => {
    const result = renderServer()
    const button = result.button()
    expect(button).toHaveAttribute("aria-describedby", "rail-help")
    expect(button).toHaveAttribute("aria-keyshortcuts", expect.stringContaining("Space"))
    fireEvent.pointerEnter(result.activationRoot())
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
