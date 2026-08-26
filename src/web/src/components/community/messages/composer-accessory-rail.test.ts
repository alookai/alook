import React from "react"
import { readFileSync } from "node:fs"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { useCommunityWsStore } from "@/stores/community/ws"
import { ComposerAccessoryRail } from "./composer-accessory-rail"

vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => React.createElement("ticker", { value }),
}))

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement("tooltip", null, children),
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: React.ReactElement
    children: React.ReactNode
  }) => React.cloneElement(render, {}, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement("tooltip-content", null, children),
}))

const baseProps = {
  typingNames: ["A very long teammate name that must not cover the center control"],
  scrollCount: 4,
  scrollMode: "jump" as const,
  onScroll: vi.fn(),
  selectMode: false,
  selectedCount: 0,
  onCancelSelection: vi.fn(),
  onShareSelection: vi.fn(),
}

describe("ComposerAccessoryRail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCommunityWsStore.getState().reset()
  })

  afterEach(() => {
    useCommunityWsStore.getState().reset()
  })

  function render(overrides: Partial<typeof baseProps> = {}) {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ComposerAccessoryRail, {
        ...baseProps,
        ...overrides,
      }))
    })
    return renderer!
  }

  function slotClassName(renderer: TestRenderer.ReactTestRenderer, testId: string): string {
    let node: TestRenderer.ReactTestInstance | null = renderer.root.findByProps({
      "data-testid": testId,
    })
    while (node && !(node.type === "div" && node.props.className?.includes("col-start-"))) {
      node = node.parent
    }
    expect(node, `${testId} must have a bounded grid slot`).not.toBeNull()
    return node!.props.className
  }

  it.each([
    [false, false, false, "empty", null, null, null],
    [true, false, false, "left-only", "col-start-1", null, null],
    [false, true, false, "centered", null, "col-start-2", null],
    [false, false, true, "right-only", null, null, "col-start-1"],
    [true, true, false, "centered", "col-start-1", "col-start-2", null],
    [true, false, true, "left-right", "col-start-1", null, "col-start-2"],
    [false, true, true, "centered", null, "col-start-2", "col-start-3"],
    [true, true, true, "centered", "col-start-1", "col-start-2", "col-start-3"],
  ] as const)(
    "renders normal DOM matrix left=%s center=%s right=%s as %s",
    (left, center, right, layout, leftColumn, centerColumn, rightColumn) => {
      if (right) useCommunityWsStore.getState().setConnectionStatus("reconnecting")
      const renderer = render({
        typingNames: left ? ["Alice"] : [],
        scrollCount: center ? 2 : 0,
      })
      const rails = renderer.root.findAllByProps({ "data-testid": tid.composerAccessoryRail })
      expect(rails).toHaveLength(layout === "empty" ? 0 : 1)
      expect(renderer.root.findAllByProps({ "data-testid": tid.typingIndicator }))
        .toHaveLength(left ? 1 : 0)
      expect(renderer.root.findAllByProps({ "data-testid": tid.scrollToPresent }))
        .toHaveLength(center ? 1 : 0)
      expect(renderer.root.findAllByProps({ "data-testid": tid.wsStatus }))
        .toHaveLength(right ? 1 : 0)
      expect(renderer.root.findAllByProps({ "data-testid": tid.wsRetry })).toHaveLength(0)
      if (layout === "empty") return

      expect(rails[0].props["data-layout"]).toBe(layout)
      if (leftColumn) {
        expect(slotClassName(renderer, tid.typingIndicator)).toContain(leftColumn)
      }
      if (centerColumn) {
        expect(slotClassName(renderer, tid.scrollToPresent)).toContain(centerColumn)
      }
      if (rightColumn) {
        const rightSlot = slotClassName(renderer, tid.wsStatus)
        expect(rightSlot).toContain(rightColumn)
        expect(rightSlot).toContain("justify-self-end")
      }
    },
  )

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("renders selection DOM matrix left=%s right=%s", (left, right) => {
    if (right) useCommunityWsStore.getState().setConnectionStatus("reconnecting")
    const renderer = render({
      selectMode: true,
      selectedCount: 2,
      typingNames: left ? ["Alice"] : [],
      scrollCount: 0,
    })
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    expect(rail.props["data-layout"]).toBe("centered")
    expect(renderer.root.findAllByProps({ "data-testid": tid.messageSelectionToolbar }))
      .toHaveLength(1)
    expect(slotClassName(renderer, tid.messageSelectionToolbar)).toContain("col-start-2")
    expect(renderer.root.findAllByProps({ "data-testid": tid.typingIndicator }))
      .toHaveLength(left ? 1 : 0)
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsStatus }))
      .toHaveLength(right ? 1 : 0)
    expect(renderer.root.findAllByProps({ "data-testid": tid.scrollToPresent })).toHaveLength(0)
    if (left) {
      const leftSlot = slotClassName(renderer, tid.typingIndicator)
      expect(leftSlot).toContain("hidden")
      expect(leftSlot).toContain("sm:col-start-1")
      expect(leftSlot).toContain("sm:block")
    }
    if (right) {
      const rightSlot = slotClassName(renderer, tid.wsStatus)
      expect(rightSlot).toContain("col-start-3")
      expect(rightSlot).toContain("justify-self-end")
    }
  })

  it("owns the only floating position and lays out normal typing, scroll, and no healthy WS node", () => {
    const renderer = render()
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    expect(rail.props.className).toContain("absolute")
    expect(rail.props["data-layout"]).toBe("centered")
    expect(rail.props.className).toContain("px-2")
    expect(rail.props.className).toContain("sm:px-4")
    expect(renderer.root.findByProps({ "data-testid": tid.typingIndicator }).props.className)
      .toContain("min-w-0")
    expect(renderer.root.findByProps({ "data-testid": tid.typingIndicator }).props.className)
      .toContain("max-w-full")
    expect(renderer.root.findByProps({ "data-testid": tid.scrollToPresent }).props["aria-label"])
      .toBe("Jump to present, 4 unread below")
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsStatus })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsRetry })).toHaveLength(0)

    const positioned = renderer.root.findAll((node) =>
      typeof node.props.className === "string" && node.props.className.includes("absolute"))
    expect(positioned).toEqual([rail])

    const grid = rail.findAllByType("div").find((node) => node.props.className?.includes("grid w-full"))!
    expect(grid.props.className)
      .toContain("grid-cols-[minmax(0,1fr)_minmax(0,max-content)_minmax(0,1fr)]")
    act(() => renderer.root.findByProps({ "data-testid": tid.scrollToPresent }).props.onClick())
    expect(baseProps.onScroll).toHaveBeenCalledOnce()
  })

  it("does not render the normal rail when all three occupancies are empty", () => {
    const renderer = render({ scrollCount: 0, typingNames: [] })
    expect(renderer.root.findAllByProps({ "data-testid": tid.composerAccessoryRail })).toHaveLength(0)
  })

  it("reclaims the center track for typing before a right-aligned WS status", () => {
    useCommunityWsStore.getState().setConnectionStatus("reconnecting")
    const renderer = render({ scrollCount: 0 })
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    expect(rail.props["data-layout"]).toBe("left-right")
    const grid = rail.findAllByType("div").find((node) => node.props.className?.includes("grid w-full"))!
    expect(grid.props.className).toContain("grid-cols-[minmax(0,1fr)_auto]")
    expect(grid.children).toHaveLength(2)
    expect(grid.children[0].props.className).toContain("col-start-1")
    expect(grid.children[0].props.className).toContain("min-w-0")
    expect(grid.children[1].props.className).toContain("col-start-2")
    expect(grid.children[1].props.className).toContain("justify-self-end")
  })

  it("shows an accessible muted warning reconnecting control without a spinner", () => {
    useCommunityWsStore.getState().setConnectionStatus("reconnecting")
    const renderer = render({ scrollCount: 0, typingNames: [] })
    const status = renderer.root.findByProps({ "data-testid": tid.wsStatus })
    expect(status.props).toMatchObject({
      "data-ws-status": "reconnecting",
      "aria-label": "WebSocket reconnecting",
      "aria-live": "polite",
      role: "status",
      tabIndex: 0,
    })
    expect(status.type).toBe("span")
    expect(status.props.className).toContain("text-warning")
    expect(status.props.className).toContain("focus-visible:ring-3")
    const statusVisuals = status.findAllByType("span")
      .filter((node) => node.props.className?.includes("size-8"))
    expect(statusVisuals).toHaveLength(2)
    expect(statusVisuals.every((node) => node.props.className.includes("self-end"))).toBe(true)
    expect(renderer.root.findByType("tooltip-content").children).toContain("Reconnecting…")
    expect(renderer.root.findAll((node) => node.props.className?.includes("animate-spin"))).toHaveLength(0)
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    expect(rail.props["data-layout"]).toBe("right-only")
    const grid = rail.findAllByType("div").find((node) => node.props.className?.includes("grid w-full"))!
    expect(grid.props.className).toContain("grid-cols-[minmax(0,1fr)]")
    expect(grid.children).toHaveLength(1)
    expect(grid.children[0].props.className).toContain("col-start-1")
    expect(grid.children[0].props.className).toContain("justify-self-end")
  })

  it("shows a destructive failed retry button with a 40px desktop hit target", () => {
    const reconnectNow = vi.fn()
    useCommunityWsStore.getState().bindReconnectNow(reconnectNow)
    useCommunityWsStore.getState().setConnectionStatus("failed")
    const renderer = render({ scrollCount: 0, typingNames: [] })
    const retry = renderer.root.findByProps({ "data-testid": tid.wsRetry })
    expect(retry.type).toBe("button")
    expect(retry.props["aria-label"]).toBe("WebSocket connection failed. Retry now")
    expect(retry.props.className).toContain("text-destructive")
    expect(retry.props.className).toContain("sm:size-10")
    const retryVisual = retry.findAllByType("span")
      .find((node) => node.props.className?.includes("size-8"))!
    expect(retryVisual.props.className).toContain("self-end")
    act(() => retry.props.onClick())
    expect(reconnectNow).toHaveBeenCalledOnce()
  })

  it("stays absent during validation, then replaces outage controls and removes them on recovery", () => {
    const renderer = render({ scrollCount: 0, typingNames: [] })
    expect(renderer.root.findAllByProps({ "data-testid": tid.composerAccessoryRail })).toHaveLength(0)

    act(() => useCommunityWsStore.getState().setConnectionStatus("reconnecting"))
    const status = renderer.root.findByProps({ "data-testid": tid.wsStatus })
    expect(status.props).toMatchObject({
      "data-ws-status": "reconnecting",
      "aria-label": "WebSocket reconnecting",
    })
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsRetry })).toHaveLength(0)

    act(() => useCommunityWsStore.getState().setConnectionStatus("failed"))
    const retry = renderer.root.findByProps({ "data-testid": tid.wsRetry })
    expect(retry.props).toMatchObject({
      "data-ws-status": "failed",
      "aria-label": "WebSocket connection failed. Retry now",
    })
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsStatus })).toHaveLength(0)

    act(() => useCommunityWsStore.getState().setConnectionStatus("connected"))
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsStatus })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsRetry })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "data-testid": tid.composerAccessoryRail })).toHaveLength(0)
  })

  it("replaces scroll with selection controls and preserves desktop typing", () => {
    const renderer = render({ selectMode: true, selectedCount: 3 })
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    expect(rail.props["data-selection"]).toBe("active")
    expect(renderer.root.findAllByProps({ "data-testid": tid.scrollToPresent })).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": tid.messageSelectionToolbar })).toBeTruthy()
    expect(renderer.root.findByProps({ "data-testid": tid.typingIndicator })).toBeTruthy()

    const grid = rail.findAllByType("div").find((node) => node.props.className?.includes("grid w-full"))!
    expect(grid.props.className)
      .toContain("grid-cols-[minmax(0,1fr)_minmax(0,max-content)_minmax(0,1fr)]")
  })

  it("uses a symmetric mobile selection grid with a compact capped toolbar and hides typing below sm", () => {
    useCommunityWsStore.getState().setConnectionStatus("failed")
    const renderer = render({ selectMode: true, selectedCount: 12 })
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    const grid = rail.findAllByType("div").find((node) => node.props.className?.includes("grid w-full"))!
    expect(grid.props.className)
      .toContain("grid-cols-[minmax(0,1fr)_minmax(0,max-content)_minmax(0,1fr)]")
    expect(grid.props.className).toContain("gap-1")
    expect(grid.props.className).toContain("sm:gap-2")

    const typingParent = renderer.root.findAllByType("div")
      .find((node) => node.props.className?.includes("hidden min-w-0 max-w-full"))!
    expect(typingParent.props.className).toContain("hidden")
    expect(typingParent.props.className).toContain("max-w-full")
    expect(typingParent.props.className).toContain("sm:block")
    const toolbar = renderer.root.findByProps({ "data-testid": tid.messageSelectionToolbar })
    expect(toolbar.props.className).toContain("h-10")
    expect(toolbar.props.className).toContain("w-fit")
    expect(toolbar.props.className).toContain("max-w-full")
    expect(toolbar.props.className).not.toContain("max-w-[calc(100vw-7rem)]")
    expect(toolbar.props.className).toContain("sm:h-auto")
    const toolbarSlot = rail.findAllByType("div")
      .find((node) => node.props.className?.includes("col-start-2"))!
    expect(toolbarSlot.props.className).toContain("justify-self-center")

    const count = toolbar.findAllByType("span")
      .find((node) => node.props.className?.includes("flex-1"))!
    expect(count.children.join("")).toBe("12 selected")
    expect(count.props.className).toContain("flex-1")
    expect(count.props.className).toContain("truncate")

    const cancel = renderer.root.findByProps({ "aria-label": "Cancel message selection" })
    expect(cancel.props.className).toContain("h-8")
    expect(cancel.props.className).toContain("w-11")
    expect(cancel.props.className).toContain("after:-inset-y-1.5")

    const share = renderer.root.findByProps({
      "aria-label": "Share 12 selected messages as image",
    })
    expect(share.props.className).toContain("h-8")
    expect(share.props.className).toContain("px-2")
    expect(share.props.className).toContain("after:-inset-y-1.5")

    const wsRetry = renderer.root.findByProps({ "data-testid": tid.wsRetry })
    expect(wsRetry.props.className).toContain("size-11")
    const wsSlot = rail.findAllByType("div")
      .find((node) => node.props.className?.includes("col-start-3"))!
    expect(wsSlot.props.className).toContain("min-w-0")
    expect(wsSlot.props.className).toContain("max-w-full")
    expect(wsSlot.props.className).toContain("justify-self-end")
  })

  it("does not reintroduce a viewport-derived rail or toolbar width cap", () => {
    const source = readFileSync(new URL("./composer-accessory-rail.tsx", import.meta.url), "utf8")
    expect(source).not.toMatch(/max-w-\[calc\([^\]]*vw/)
  })
})
