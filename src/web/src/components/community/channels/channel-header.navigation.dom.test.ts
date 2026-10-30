import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
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
  it.each([
    ["thread", "Post"], ["text", "channel"], ["forum", "Forum title"],
  ] as const)("replaces only the unresolved %s title and accepts the real name %s", (kind, channel) => {
    const back = vi.fn()
    const node = (titleState: "ready" | "pending" | "unavailable") => createElement(ChannelHeader, {
      channel, kind, titleState, rightPanel: null, onToggle: vi.fn(), mobileBack: back,
      tools: { members: false, threads: false, pinned: false },
    })
    const view = render(node("pending"))
    const header = screen.getByRole("banner")
    const identity = header.querySelector('[data-slot="message-header-identity"]')
    const actions = header.querySelector('[data-slot="message-header-actions"]')
    const button = screen.getByRole("button", { name: "Back" })
    expect(screen.getByTestId(tid.messageHeaderTitleLoading)).toHaveClass("h-4", "w-32")
    expect(screen.queryByTitle(channel)).toBeNull()
    view.rerender(node("ready"))
    expect(screen.queryByTestId(tid.messageHeaderTitleLoading)).toBeNull()
    expect(screen.getByTitle(channel)).toHaveTextContent(channel)
    expect(screen.getByRole("banner")).toBe(header)
    expect(header.querySelector('[data-slot="message-header-identity"]')).toBe(identity)
    expect(header.querySelector('[data-slot="message-header-actions"]')).toBe(actions)
    expect(screen.getByRole("button", { name: "Back" })).toBe(button)
    fireEvent.click(button)
    expect(back).toHaveBeenCalledOnce()
    view.unmount()
  })

  it("keeps an unavailable title static and retries only its resource while Back remains usable", () => {
    const back = vi.fn(), retry = vi.fn()
    const node = (retryingTitle = false) => createElement(ChannelHeader, {
      channel: "Post", titleState: "unavailable", retryingTitle, onRetryTitle: retry,
      rightPanel: null, onToggle: vi.fn(), mobileBack: back,
      tools: { members: false, threads: false, pinned: false },
    } as const)
    const view = render(node())
    const title = screen.getByRole("img", { name: "Title unavailable" })
    expect(title).toHaveAttribute("data-title-state", "unavailable")
    expect(title).not.toHaveClass("animate-pulse")
    expect(screen.queryByTitle("Post")).toBeNull()
    const button = screen.getByRole("button", { name: "Retry title" })
    fireEvent.click(button)
    expect(retry).toHaveBeenCalledOnce()
    view.rerender(node(true))
    expect(screen.getByRole("button", { name: "Retry title" })).toBe(button)
    expect(button).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(back).toHaveBeenCalledOnce()
    view.unmount()
  })

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

  it("keeps transient typing presence out of the header footprint", () => {
    const renderer = renderHeader()
    expect(renderer.queryByTestId(tid.typingIndicator)).not.toBeInTheDocument()
    expect(renderer.getByRole("banner")).toHaveClass("h-12", "shrink-0")
  })
})
