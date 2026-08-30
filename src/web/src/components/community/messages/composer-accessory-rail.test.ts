import React from "react"
import { readFileSync } from "node:fs"
import { X } from "lucide-react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { useCommunityWsStore } from "@/stores/community/ws"
import { ComposerAccessoryRail, selectionTypingFits } from "./composer-accessory-rail"

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
  typingNames: [] as string[],
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
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ComposerAccessoryRail, {
        ...baseProps,
        ...overrides,
      }))
    })
    return renderer
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
    [false, false, "empty"],
    [true, false, "left-only"],
    [false, true, "centered"],
    [true, true, "centered"],
  ] as const)(
    "renders typing=%s scroll=%s as %s",
    (typing, center, layout) => {
      const renderer = render({
        typingNames: typing ? ["Alice"] : [],
        scrollCount: center ? 2 : 0,
      })
      const rails = renderer.root.findAllByProps({ "data-testid": tid.composerAccessoryRail })
      expect(rails).toHaveLength(layout === "empty" ? 0 : 1)
      expect(renderer.root.findAllByProps({ "data-testid": tid.scrollToPresent }))
        .toHaveLength(center ? 1 : 0)
      expect(renderer.root.findAllByProps({ "data-testid": tid.typingIndicator }))
        .toHaveLength(typing ? 1 : 0)
      if (layout === "empty") return

      expect(rails[0].props["data-layout"]).toBe(layout)
      if (center) expect(slotClassName(renderer, tid.scrollToPresent)).toContain("col-start-2")
      if (typing) expect(slotClassName(renderer, tid.typingIndicator)).toContain("col-start-1")
    },
  )

  it("keeps selection centered, starts typing hidden pending measurement, and wires its actions", () => {
    const renderer = render({
      typingNames: ["Alice"],
      selectMode: true,
      selectedCount: 12,
    })
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    expect(rail.props).toMatchObject({
      "data-layout": "centered",
      "data-selection": "active",
    })
    expect(renderer.root.findAllByProps({ "data-testid": tid.scrollToPresent })).toHaveLength(0)
    expect(slotClassName(renderer, tid.messageSelectionToolbar)).toContain("col-start-2")
    const typingSlot = slotClassName(renderer, tid.typingIndicator)
    expect(typingSlot).toContain("col-start-1")
    expect(typingSlot).not.toContain("sm:block")
    expect(renderer.root.findByProps({ "data-selection-typing-fit": "pending" })).toBeDefined()

    const toolbar = renderer.root.findByProps({ "data-testid": tid.messageSelectionToolbar })
    expect(toolbar.props.className).toContain("h-10")
    expect(toolbar.props.className).toContain("max-w-full")
    const cancel = renderer.root.findByProps({ "aria-label": "Cancel message selection" })
    const share = renderer.root.findByProps({
      "aria-label": "Share 12 selected messages as image",
    })
    expect(cancel.props.className).toContain("w-11")
    expect(cancel.props.className).toContain("text-foreground")
    expect(cancel.findByType(X).props.className).toBe("text-foreground")
    expect(cancel.findAllByType("span").find((node) => node.children.includes("Cancel"))?.props.className)
      .toContain("text-foreground")
    expect(share.props.className).toContain("after:-inset-y-1.5")
    act(() => cancel.props.onClick())
    act(() => share.props.onClick())
    expect(baseProps.onCancelSelection).toHaveBeenCalledOnce()
    expect(baseProps.onShareSelection).toHaveBeenCalledOnce()
  })

  it("shows selection typing only when the complete intrinsic pill fits", () => {
    expect(selectionTypingFits(160, 160)).toBe(true)
    expect(selectionTypingFits(160, 159.5)).toBe(true)
    expect(selectionTypingFits(160, 160.5)).toBe(false)
    expect(selectionTypingFits(0, 0)).toBe(false)
  })

  it("centers the scroll control, preserves the floating boundary, and wires scroll", () => {
    const renderer = render()
    const rail = renderer.root.findByProps({ "data-testid": tid.composerAccessoryRail })
    expect(rail.props.className).toContain("absolute")
    const railClasses = rail.props.className.split(" ")
    expect(railClasses).toContain("bottom-2")
    expect(railClasses).toContain("sm:bottom-4")
    expect(railClasses).not.toContain("bottom-3")
    expect(rail.props["data-layout"]).toBe("centered")
    expect(renderer.root.findByProps({ "data-testid": tid.scrollToPresent }).props["aria-label"])
      .toBe("Jump to present, 4 unread below")
    const grid = rail.findAllByType("div").find((node) => node.props.className?.includes("grid w-full"))!
    expect(grid.props.className)
      .toContain("grid-cols-[minmax(0,1fr)_minmax(0,max-content)_minmax(0,1fr)]")
    act(() => renderer.root.findByProps({ "data-testid": tid.scrollToPresent }).props.onClick())
    expect(baseProps.onScroll).toHaveBeenCalledOnce()
  })

  it("never reserves composer space for WebSocket state", () => {
    useCommunityWsStore.getState().setConnectionStatus("reconnecting")
    const empty = render({ scrollCount: 0 })
    expect(empty.root.findAllByProps({ "data-testid": tid.composerAccessoryRail })).toHaveLength(0)

    useCommunityWsStore.getState().setConnectionStatus("failed")
    const failed = render({ scrollCount: 0 })
    expect(failed.root.findAllByProps({ "data-testid": tid.composerAccessoryRail })).toHaveLength(0)
    expect(failed.root.findAllByProps({ "data-testid": tid.wsRetry })).toHaveLength(0)
  })

  it("does not reintroduce WS ownership or a viewport-derived width cap", () => {
    const source = readFileSync(new URL("./composer-accessory-rail.tsx", import.meta.url), "utf8")
    expect(source).not.toContain("@/stores/community/ws")
    expect(source).not.toContain("WsStatusControl")
    expect(source).not.toMatch(/max-w-\[calc\([^\]]*vw/)
    expect(source).not.toContain('className="hidden min-w-0 max-w-full sm:col-start-1 sm:block"')
  })
})
