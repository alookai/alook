import React from "react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { useCommunityWsStore } from "@/stores/community/ws"
import { fireEvent, render } from "@/test/react-dom-harness"
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

const railProps = {
  scrollCount: 4,
  scrollMode: "jump" as const,
  onScroll: vi.fn(),
}

describe("ComposerAccessoryRail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCommunityWsStore.getState().reset()
  })

  afterEach(() => {
    useCommunityWsStore.getState().reset()
  })

  it("renders only the away scroll control and preserves its floating boundary", () => {
    const renderer = render(React.createElement(ComposerAccessoryRail, railProps))
    const rail = renderer.getByTestId(tid.composerAccessoryRail)
    expect(rail).toHaveAttribute("data-layout", "centered")
    expect(rail).toHaveClass("absolute", "bottom-2", "sm:bottom-4")
    expect(rail).not.toHaveAttribute("style")
    const scroll = renderer.getByTestId(tid.scrollToPresent)
    expect(scroll).toHaveAttribute("aria-label", "Jump to present, 4 unread below")
    expect(scroll.closest('div[class*="col-start-"]')).toHaveClass("col-start-2")
    fireEvent.click(scroll)
    expect(railProps.onScroll).toHaveBeenCalledOnce()
  })

  it("stays absent at the tail regardless of WebSocket state", () => {
    const renderEmpty = () => render(React.createElement(ComposerAccessoryRail, {
      ...railProps,
      scrollCount: 0,
    }))
    useCommunityWsStore.getState().setConnectionStatus("reconnecting")
    expect(renderEmpty().queryAllByTestId(tid.composerAccessoryRail)).toHaveLength(0)
    useCommunityWsStore.getState().setConnectionStatus("failed")
    const failed = renderEmpty()
    expect(failed.queryAllByTestId(tid.composerAccessoryRail)).toHaveLength(0)
    expect(failed.queryAllByTestId(tid.wsRetry)).toHaveLength(0)
  })

  it("keeps typing and selection ownership out of the viewport rail", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/components/community/messages/composer-accessory-rail.tsx",
    ), "utf8")
    expect(source).not.toContain("@/stores/community/ws")
    expect(source).not.toContain("TypingIndicator")
    expect(source).not.toContain("selectionTypingFits")
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
    expect(cancel.querySelector("svg")).toHaveClass("text-foreground")
    expect(share).toHaveClass("after:-inset-y-1.5")
    fireEvent.click(cancel)
    fireEvent.click(share)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onShare).toHaveBeenCalledOnce()
  })
})
