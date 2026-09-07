import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { ChannelHeader } from "./channel-header"

function renderHeader(overrides: Record<string, unknown> = {}) {
  return render(createElement(ChannelHeader, {
    channel: "general",
    rightPanel: null,
    onToggle: vi.fn(),
    tools: { members: false, threads: false, pinned: false },
    ...overrides,
  }))
}

describe("ChannelHeader hierarchy navigation", () => {
  it("uses one mobile-only 44px Back control for a top-level channel", () => {
    const onNavigate = vi.fn()
    renderHeader({
      mobileBack: onNavigate,
    })

    const back = screen.getByRole("button", { name: "Back" })
    expect(back).toHaveClass("size-11", "sm:hidden")
    fireEvent.click(back)
    expect(onNavigate).toHaveBeenCalledOnce()
  })

  it("uses the same mobile Back control for a direct child parent", () => {
    const onNavigateParent = vi.fn()
    renderHeader({
      mobileBack: onNavigateParent,
      channel: "Thread title",
      kind: "thread",
      onRename: vi.fn(),
    })

    const back = screen.getByRole("button", { name: "Back" })
    expect(back).toHaveClass("size-11", "sm:hidden")
    expect(screen.getByRole("button", { name: "Rename" })).toHaveClass("hidden", "sm:inline-flex")
    fireEvent.click(back)
    expect(onNavigateParent).toHaveBeenCalledOnce()
  })

  it("shows only the current child identity and keeps parent navigation in Back", () => {
    const onNavigateParent = vi.fn()
    const rendered = renderHeader({
      mobileBack: onNavigateParent,
      kind: "thread",
      channel: "Thread title",
    })

    const current = screen.getByTitle("Thread title")
    expect(current.tagName).toBe("SPAN")
    expect(current).toHaveClass("min-w-0")
    expect(rendered.container.querySelector(".lucide-hash")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(onNavigateParent).toHaveBeenCalledOnce()
  })

  it("renders only supplied panel actions in compact split mode", () => {
    renderHeader({
      compactActions: true,
      tools: undefined,
      notifLevel: "all",
      onSetNotifLevel: vi.fn(),
      endActions: createElement("button", { "aria-label": "Open thread full screen" }),
    })

    expect(screen.queryByRole("button", { name: "Member list" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Channel notifications" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "More channel options" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open thread full screen" })).toBeInTheDocument()
  })
})
