import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render as renderDom, screen, within } from "@/test/react-dom-harness"
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

  function expectAppEdgeFade(overlay: HTMLElement) {
    const fade = overlay.querySelector<HTMLElement>('[data-slot="app-edge-fade"]')!
    expect(fade).toHaveAttribute("aria-hidden", "true")
    expect(fade).toHaveClass("pointer-events-none", "absolute", "inset-0")
    expect(fade.querySelectorAll("[data-app-edge]")).toHaveLength(2)
    expect(fade.querySelector('[data-app-edge="top"]')).toHaveClass(
      "top-0",
      "h-(--app-edge-fade-size)",
      "from-(--app-bg)",
      "to-transparent",
    )
    expect(fade.querySelector('[data-app-edge="bottom"]')).toHaveClass(
      "bottom-0",
      "h-(--app-edge-fade-size)",
      "from-transparent",
      "to-(--app-bg)",
    )
    expect(fade.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0)
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
    expect(overlay).toHaveClass("bg-background/60", "supports-backdrop-filter:bg-background/45")
    expectAppEdgeFade(overlay)
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true")
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
    expect(screen.getByRole("status")).toHaveAttribute("data-slot", "text-loader")
    expect(screen.getByRole("status")).toHaveAttribute("data-variant", "default")
    expect(screen.getByRole("heading", { name: "Connecting…" })).toBeInTheDocument()
    const motion = overlay.querySelector<HTMLElement>("[data-connecting-motion]")!
    expect(motion).toHaveAttribute("aria-hidden", "true")
    expect(motion).toHaveClass("h-36", "w-44", "sm:h-40", "sm:w-48", "items-center")
    expect(motion.querySelectorAll("svg")).toHaveLength(5)
    expect(motion.querySelector("[role=status]")).toHaveClass("scale-90", "sm:scale-100")
    expect(motion.querySelector("[role=status]")).toHaveStyle({ width: "192px", height: "192px" })
    expect(overlay.querySelector(".community-ws-connecting-text")).toHaveClass("font-heading")
    expect(overlay.querySelectorAll(".community-ws-connecting-letter")).toHaveLength(11)
    expect(overlay.querySelector(".community-ws-connecting-text")).toHaveTextContent("Connecting…")
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
    expectAppEdgeFade(screen.getByTestId(tid.wsReconnectOverlay))
    const retry = screen.getByTestId(tid.wsRetry)
    expect(retry).toHaveClass("h-11", "sm:h-10")
    fireEvent.click(retry)
    expect(reconnectNow).toHaveBeenCalledOnce()

    act(() => useCommunityWsStore.getState().setConnectionStatus("connected"))
    expect(screen.queryByTestId(tid.wsReconnectOverlay)).not.toBeInTheDocument()
    expect(renderer.container.querySelector(".contents")).not.toHaveAttribute("inert")
  })
})
