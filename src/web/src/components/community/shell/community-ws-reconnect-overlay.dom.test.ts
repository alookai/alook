import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render as renderDom, screen, within } from "@/test/react-dom-harness"
import { tid } from "@/lib/community/testids"
import { useCommunityWsStore } from "@/stores/community/ws"
import { CommunityWsReconnectBoundary } from "./community-ws-reconnect-overlay"

describe("CommunityWsReconnectBoundary", () => {
  beforeEach(() => {
    useCommunityWsStore.getState().reset()
  })

  afterEach(() => {
    useCommunityWsStore.getState().reset()
    vi.restoreAllMocks()
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

  it("blocks the content and announces a reconnecting state", () => {
    const { renderer, focus } = render()
    act(() => useCommunityWsStore.getState().setConnectionStatus("reconnecting"))

    const content = renderer.container.querySelector(".contents")!
    expect(content).toHaveAttribute("inert")
    expect(content).toHaveAttribute("aria-hidden", "true")
    const overlay = screen.getByTestId(tid.wsReconnectOverlay)
    expect(overlay).toHaveAttribute("data-ws-status", "reconnecting")
    expect(overlay).toHaveAttribute("aria-modal", "true")
    expect(overlay).toHaveAttribute("tabindex", "-1")
    expect(overlay).toHaveClass(
      "fixed",
      "inset-0",
      "community-ws-reconnect-overlay",
      "z-2147483647",
      "backdrop-blur-sm",
    )
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true")
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
    expect(screen.getByRole("heading", { name: "Connecting…" })).toBeInTheDocument()
    const motion = overlay.querySelector<SVGElement>("[data-connecting-motion]")!
    expect(motion.tagName.toLowerCase()).toBe("svg")
    expect(motion).toHaveClass("community-ws-connecting-loader")
    expect(motion.querySelectorAll("rect")).toHaveLength(2)
    expect(motion.querySelector("circle")).toHaveClass("community-ws-connecting-dot")
    expect(motion.querySelectorAll("filter")).toHaveLength(1)
    expect(motion.querySelectorAll("feBlend")).toHaveLength(1)
    expect(screen.queryByTestId(tid.wsRetry)).not.toBeInTheDocument()
    expect(focus).toHaveBeenCalledOnce()
  })

  it("shows an accessible mobile-sized Retry action and restores immediately", () => {
    const reconnectNow = vi.fn()
    useCommunityWsStore.getState().bindReconnectNow(reconnectNow)
    const { renderer } = render()
    act(() => useCommunityWsStore.getState().setConnectionStatus("failed"))

    const alert = screen.getByRole("alert")
    expect(alert).toHaveAttribute("aria-atomic", "true")
    expect(alert).toHaveAttribute("aria-live", "assertive")
    expect(within(alert).getByRole("heading", { name: "Connection lost" })).toBeInTheDocument()
    const retry = screen.getByTestId(tid.wsRetry)
    expect(retry).toHaveClass("h-11", "sm:h-10")
    fireEvent.click(retry)
    expect(reconnectNow).toHaveBeenCalledOnce()

    act(() => useCommunityWsStore.getState().setConnectionStatus("connected"))
    expect(screen.queryByTestId(tid.wsReconnectOverlay)).not.toBeInTheDocument()
    expect(renderer.container.querySelector(".contents")).not.toHaveAttribute("inert")
  })
})
