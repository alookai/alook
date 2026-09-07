import React from "react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { useCommunityWsStore } from "@/stores/community/ws"
import { fireEvent, render as rtlRender, type RenderResult } from "@/test/react-dom-harness"
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

  function renderRail(overrides: Partial<typeof baseProps> = {}) {
    return rtlRender(React.createElement(ComposerAccessoryRail, {
      ...baseProps,
      ...overrides,
    }))
  }

  function slotClassName(renderer: RenderResult, testId: string): string {
    const node = renderer.getByTestId(testId).closest('div[class*="col-start-"]')
    expect(node, `${testId} must have a bounded grid slot`).not.toBeNull()
    return node!.className
  }

  it.each([
    [false, false, "empty"],
    [true, false, "left-only"],
    [false, true, "centered"],
    [true, true, "centered"],
  ] as const)(
    "renders typing=%s scroll=%s as %s",
    (typing, center, layout) => {
      const renderer = renderRail({
        typingNames: typing ? ["Alice"] : [],
        scrollCount: center ? 2 : 0,
      })
      const rails = renderer.queryAllByTestId(tid.composerAccessoryRail)
      expect(rails).toHaveLength(layout === "empty" ? 0 : 1)
      expect(renderer.queryAllByTestId(tid.scrollToPresent))
        .toHaveLength(center ? 1 : 0)
      expect(renderer.queryAllByTestId(tid.typingIndicator))
        .toHaveLength(typing ? 1 : 0)
      if (layout === "empty") return

      expect(rails[0]).toHaveAttribute("data-layout", layout)
      if (center) expect(slotClassName(renderer, tid.scrollToPresent)).toContain("col-start-2")
      if (typing) expect(slotClassName(renderer, tid.typingIndicator)).toContain("col-start-1")
    },
  )

  it("keeps selection centered, hides typing when it cannot fit, and wires its actions", () => {
    const renderer = renderRail({
      typingNames: ["Alice"],
      selectMode: true,
      selectedCount: 12,
    })
    const rail = renderer.getByTestId(tid.composerAccessoryRail)
    expect(rail).toHaveAttribute("data-layout", "centered")
    expect(rail).toHaveAttribute("data-selection", "active")
    expect(renderer.queryAllByTestId(tid.scrollToPresent)).toHaveLength(0)
    expect(slotClassName(renderer, tid.messageSelectionToolbar)).toContain("col-start-2")
    const typingSlot = slotClassName(renderer, tid.typingIndicator)
    expect(typingSlot).toContain("col-start-1")
    expect(typingSlot).not.toContain("sm:block")
    expect(renderer.container.querySelector('[data-selection-typing-fit="hidden"]')).not.toBeNull()

    const toolbar = renderer.getByTestId(tid.messageSelectionToolbar)
    expect(toolbar).toHaveClass("h-10", "max-w-full")
    const cancel = renderer.getByRole("button", { name: "Cancel message selection" })
    const share = renderer.getByRole("button", {
      name: "Share 12 selected messages as image",
    })
    expect(cancel).toHaveClass("w-11", "text-foreground")
    expect(cancel.querySelector("svg")).toHaveClass("text-foreground")
    const cancelLabel = Array.from(cancel.querySelectorAll("span"))
      .find((node) => node.textContent === "Cancel")
    expect(cancelLabel).toHaveClass("text-foreground")
    expect(share).toHaveClass("after:-inset-y-1.5")
    fireEvent.click(cancel)
    fireEvent.click(share)
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
    const renderer = renderRail()
    const rail = renderer.getByTestId(tid.composerAccessoryRail)
    expect(rail).toHaveClass("absolute")
    const railClasses = rail.className.split(" ")
    expect(railClasses).toContain("bottom-2")
    expect(railClasses).toContain("sm:bottom-4")
    expect(railClasses).not.toContain("bottom-3")
    expect(rail).toHaveAttribute("data-layout", "centered")
    const scroll = renderer.getByTestId(tid.scrollToPresent)
    expect(scroll).toHaveAttribute("aria-label", "Jump to present, 4 unread below")
    const grid = rail.querySelector<HTMLElement>("div.grid.w-full")!
    expect(grid.className)
      .toContain("grid-cols-[minmax(0,1fr)_minmax(0,max-content)_minmax(0,1fr)]")
    fireEvent.click(scroll)
    expect(baseProps.onScroll).toHaveBeenCalledOnce()
  })

  it("never reserves composer space for WebSocket state", () => {
    useCommunityWsStore.getState().setConnectionStatus("reconnecting")
    const empty = renderRail({ scrollCount: 0 })
    expect(empty.queryAllByTestId(tid.composerAccessoryRail)).toHaveLength(0)

    useCommunityWsStore.getState().setConnectionStatus("failed")
    const failed = renderRail({ scrollCount: 0 })
    expect(failed.queryAllByTestId(tid.composerAccessoryRail)).toHaveLength(0)
    expect(failed.queryAllByTestId(tid.wsRetry)).toHaveLength(0)
  })

  it("does not reintroduce WS ownership or a viewport-derived width cap", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/components/community/messages/composer-accessory-rail.tsx",
    ), "utf8")
    expect(source).not.toContain("@/stores/community/ws")
    expect(source).not.toContain("WsStatusControl")
    expect(source).not.toMatch(/max-w-\[calc\([^\]]*vw/)
    expect(source).not.toContain('className="hidden min-w-0 max-w-full sm:col-start-1 sm:block"')
  })
})
