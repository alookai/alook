import { createElement, Fragment, type ReactNode } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SortableServer } from "./sortable-server"
import { tid } from "@/lib/community/testids"

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

function renderServer(active = false, mentions = 0) {
  const buttonNodes: Array<{ focus: ReturnType<typeof vi.fn> }> = []
  const renderer = TestRenderer.create(createElement(SortableServer, {
    server: { ...server, mentions },
    active,
    onClick: vi.fn(),
    dragDescriptionId: "rail-help",
  }), {
    createNodeMock: (element) => {
      if (element.type !== "button") return {}
      const node = { focus: vi.fn() }
      buttonNodes.push(node)
      return node
    },
  })
  const activationRoot = () => renderer.root.findAllByType("div")
    .find((node) => typeof node.props.onFocusCapture === "function")!
  return { renderer, buttonNodes, activationRoot }
}

describe("SortableServer lazy menu focus", () => {
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
  afterEach(() => vi.unstubAllGlobals())

  it("refocuses the icon after first focus activates and replaces its menu wrapper", async () => {
    let result!: ReturnType<typeof renderServer>
    await act(async () => { result = renderServer() })

    await act(async () => result.activationRoot().props.onFocusCapture())

    expect(result.renderer.root.findAllByType("context-menu-trigger")).toHaveLength(1)
    expect(result.buttonNodes.at(-1)?.focus).toHaveBeenCalledTimes(1)
  })

  it("does not steal focus when pointer hover activates the menu", async () => {
    let result!: ReturnType<typeof renderServer>
    await act(async () => { result = renderServer() })

    await act(async () => result.activationRoot().props.onPointerEnter())

    expect(result.renderer.root.findAllByType("context-menu-trigger")).toHaveLength(1)
    expect(result.buttonNodes.every((node) => node.focus.mock.calls.length === 0)).toBe(true)
  })

  it("exposes keyboard drag help without positional menu shortcuts", async () => {
    let result!: ReturnType<typeof renderServer>
    await act(async () => { result = renderServer() })
    const button = result.renderer.root.findByType("button")
    expect(button.props["aria-describedby"]).toBe("rail-help")
    expect(button.props["aria-keyshortcuts"]).toContain("Space")
    await act(async () => result.activationRoot().props.onPointerEnter())
    const menuText = JSON.stringify(result.renderer.toJSON())
    expect(menuText).not.toContain("Move…")
    expect(menuText).not.toContain("Create group")
  })

  it("keeps active and inactive cursor state on the actual button", async () => {
    let active!: ReturnType<typeof renderServer>
    let inactive!: ReturnType<typeof renderServer>
    await act(async () => {
      active = renderServer(true)
      inactive = renderServer(false)
    })

    expect(active.renderer.root.findByType("button").props.className).toContain("cursor-default")
    expect(inactive.renderer.root.findByType("button").props.className).toContain("cursor-pointer")
  })

  it("stacks the numeric mention badge above the icon without changing its presentation", async () => {
    let result!: ReturnType<typeof renderServer>
    await act(async () => { result = renderServer(false, 12) })

    const button = result.renderer.root.findByType("button")
    const badge = result.renderer.root.findByProps({ "data-testid": tid.railUnreadBadge("a") })
    const dragPreview = result.renderer.root.findByProps({ "data-rail-drag-preview": true })
    expect(button.props.className).toContain("z-1")
    expect(badge.props.className).toContain("z-2")
    expect(badge.props.className).toContain("bg-primary")
    expect(badge.props.className).toContain("min-w-5")
    expect(badge.props.className).toContain("px-1")
    expect(dragPreview.props.className).toContain("size-10")
    expect(dragPreview.findAllByProps({ "data-testid": tid.railUnreadBadge("a") })).toHaveLength(0)
  })
})
