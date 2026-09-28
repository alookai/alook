import React from "react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { fireEvent, render, type RenderResult } from "@/test/react-dom-harness"
import { ComposerAccessoryRail, MessageSelectionFooter } from "./composer-accessory-rail"

vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => React.createElement("ticker", { value }),
}))

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement("tooltip", null, children),
  TooltipTrigger: ({
    render: trigger,
    children,
  }: {
    render: React.ReactElement
    children: React.ReactNode
  }) => React.cloneElement(trigger, {}, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement("tooltip-content", null, children),
}))

const baseProps = {
  typingNames: [] as string[],
  scrollCount: 4,
  scrollMode: "jump" as const,
  onScroll: vi.fn(),
}

describe("ComposerAccessoryRail", () => {
  beforeEach(() => vi.clearAllMocks())

  function renderRail(overrides: Partial<typeof baseProps> = {}) {
    return render(React.createElement(ComposerAccessoryRail, {
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
      expect(renderer.queryAllByTestId(tid.scrollToPresent)).toHaveLength(center ? 1 : 0)
      expect(renderer.queryAllByTestId(tid.typingIndicator)).toHaveLength(typing ? 1 : 0)
      if (layout === "empty") return

      expect(rails[0]).toHaveAttribute("data-layout", layout)
      if (center) expect(slotClassName(renderer, tid.scrollToPresent)).toContain("col-start-2")
      if (typing) expect(slotClassName(renderer, tid.typingIndicator)).toContain("col-start-1")
    },
  )

  it("centers the scroll control without owning composer geometry", () => {
    const renderer = renderRail()
    const rail = renderer.getByTestId(tid.composerAccessoryRail)
    expect(rail).toHaveClass("absolute", "bottom-2", "sm:bottom-4")
    expect(rail).not.toHaveAttribute("style")
    const scroll = renderer.getByTestId(tid.scrollToPresent)
    expect(scroll).toHaveAttribute("aria-label", "Jump to present, 4 unread below")
    fireEvent.click(scroll)
    expect(baseProps.onScroll).toHaveBeenCalledOnce()
  })

  it("does not reintroduce WS or viewport-derived width ownership", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/components/community/messages/composer-accessory-rail.tsx",
    ), "utf8")
    expect(source).not.toContain("@/stores/community/ws")
    expect(source).not.toMatch(/max-w-\[calc\([^\]]*vw/)
  })
})

describe("MessageSelectionFooter", () => {
  it("fills the composer slot and wires cancel and share actions", () => {
    const onCancel = vi.fn()
    const onShare = vi.fn()
    const renderer = render(React.createElement(MessageSelectionFooter, {
      selectedCount: 12,
      onCancel,
      onShare,
    }))
    const footer = renderer.container.querySelector('[data-selection="active"]')
    expect(footer).toHaveClass("absolute", "inset-0", "bg-(--app-bg)")
    const toolbar = renderer.getByTestId(tid.messageSelectionToolbar)
    expect(toolbar).toHaveClass("h-10", "max-w-full")
    const cancel = renderer.getByRole("button", { name: "Cancel message selection" })
    const share = renderer.getByRole("button", {
      name: "Share 12 selected messages as image",
    })
    expect(cancel).toHaveClass("w-11", "text-foreground")
    expect(share).toHaveClass("after:-inset-y-1.5")
    fireEvent.click(cancel)
    fireEvent.click(share)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onShare).toHaveBeenCalledOnce()
  })
})
