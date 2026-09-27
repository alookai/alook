import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render as renderDom, screen } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { useCommunityWsStore } from "@/stores/community/ws"
import { CommunityWsReconnectBoundary } from "./community-ws-reconnect-overlay"

describe("CommunityWsReconnectBoundary", () => {
  beforeEach(() => {
    useCommunityWsStore.getState().reset()
    vi.stubGlobal("matchMedia", vi.fn(() => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()})))
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    useCommunityWsStore.getState().reset()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function render() {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const renderer = renderDom(React.createElement(
      CommunityWsReconnectBoundary,
      null,
      React.createElement("button", { type: "button" }, "Underlying action"),
    ))
    return { renderer, focus }
  }

  it("leaves connected content interactive without rendering an overlay", () => {
    const { renderer } = render()
    const content = renderer.container.querySelector(".contents")!
    expect(content).not.toHaveAttribute("inert")
    expect(content).not.toHaveAttribute("aria-hidden")
    expect(screen.queryByTestId(tid.wsReconnectOverlay)).not.toBeInTheDocument()
  })

  it("keeps cached content interactive while connecting or reconnecting", () => {
    const { renderer, focus } = render()
    act(() => useCommunityWsStore.getState().setConnectionStatus("reconnecting"))

    const content = renderer.container.querySelector(".contents")!
    expect(content).not.toHaveAttribute("inert")
    expect(content).not.toHaveAttribute("aria-hidden")
    expect(screen.queryByTestId(tid.wsReconnectOverlay)).not.toBeInTheDocument()
    expect(focus).not.toHaveBeenCalled()
  })

  it("shows a non-modal Retry status without disabling cached content", () => {
    const reconnectNow = vi.fn()
    useCommunityWsStore.getState().bindReconnectNow(reconnectNow)
    const { renderer } = render()
    act(() => useCommunityWsStore.getState().setConnectionStatus("failed"))

    const status = screen.getByRole("status")
    expect(status).toHaveAttribute("aria-atomic", "true")
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(status).not.toHaveAttribute("aria-modal")
    expect(status).toHaveTextContent("Connection lost")
    expect(status).toHaveTextContent("Cached content is still available.")
    expect(renderer.container.querySelector(".contents")).not.toHaveAttribute("inert")
    const retry = screen.getByTestId(tid.wsRetry)
    expect(retry).toHaveClass("h-11", "sm:h-9")
    fireEvent.click(retry)
    expect(reconnectNow).toHaveBeenCalledOnce()

    act(() => useCommunityWsStore.getState().setConnectionStatus("connected"))
    expect(screen.queryByTestId(tid.wsReconnectOverlay)).not.toBeInTheDocument()
    expect(renderer.container.querySelector(".contents")).not.toHaveAttribute("inert")
  })
})
