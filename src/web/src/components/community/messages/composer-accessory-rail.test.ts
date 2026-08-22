import React from "react"
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

  it("owns the only floating position and lays out normal typing, scroll, and no healthy WS node", () => {
    const renderer = render()
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    expect(rail.props.className).toContain("absolute")
    expect(rail.props.className).toContain("px-2")
    expect(rail.props.className).toContain("sm:px-4")
    expect(renderer.root.findByProps({ "data-testid": tid.typingIndicator }).props.className)
      .toContain("min-w-0")
    expect(renderer.root.findByProps({ "data-testid": tid.scrollToPresent }).props["aria-label"])
      .toBe("Jump to present, 4 unread below")
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsStatus })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsRetry })).toHaveLength(0)

    const positioned = renderer.root.findAll((node) =>
      typeof node.props.className === "string" && node.props.className.includes("absolute"))
    expect(positioned).toEqual([rail])
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
    expect(renderer.root.findByType("tooltip-content").children).toContain("Reconnecting…")
    expect(renderer.root.findAll((node) => node.props.className?.includes("animate-spin"))).toHaveLength(0)
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
    act(() => retry.props.onClick())
    expect(reconnectNow).toHaveBeenCalledOnce()
  })

  it("replaces scroll with selection controls and preserves desktop typing", () => {
    const renderer = render({ selectMode: true, selectedCount: 3 })
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    expect(rail.props["data-selection"]).toBe("active")
    expect(renderer.root.findAllByProps({ "data-testid": tid.scrollToPresent })).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": tid.messageSelectionToolbar })).toBeTruthy()
    expect(renderer.root.findByProps({ "data-testid": tid.typingIndicator })).toBeTruthy()

    const grid = rail.findAllByType("div").find((node) => node.props.className?.includes("grid w-full"))!
    expect(grid.props.className).toContain("grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]")
  })

  it("uses a symmetric mobile selection grid with a compact capped toolbar and hides typing below sm", () => {
    useCommunityWsStore.getState().setConnectionStatus("failed")
    const renderer = render({ selectMode: true, selectedCount: 12 })
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    const grid = rail.findAllByType("div").find((node) => node.props.className?.includes("grid w-full"))!
    expect(grid.props.className).toContain("grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]")
    expect(grid.props.className).toContain("gap-1")
    expect(grid.props.className).toContain("sm:gap-2")

    const typingParent = renderer.root.findAllByType("div")
      .find((node) => node.props.className?.includes("hidden w-full min-w-0"))!
    expect(typingParent.props.className).toContain("hidden")
    expect(typingParent.props.className).toContain("w-full")
    expect(typingParent.props.className).toContain("sm:block")
    const toolbar = renderer.root.findByProps({ "data-testid": tid.messageSelectionToolbar })
    expect(toolbar.props.className).toContain("h-10")
    expect(toolbar.props.className).toContain("max-w-[calc(100vw-7rem)]")
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
    expect(wsSlot.props.className).toContain("min-w-11")
    expect(wsSlot.props.className).toContain("justify-self-end")
  })
})
