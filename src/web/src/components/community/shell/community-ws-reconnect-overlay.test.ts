import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { useCommunityWsStore } from "@/stores/community/ws"
import { CommunityWsReconnectBoundary } from "./community-ws-reconnect-overlay"

describe("CommunityWsReconnectBoundary", () => {
  beforeEach(() => {
    useCommunityWsStore.getState().reset()
  })

  afterEach(() => {
    useCommunityWsStore.getState().reset()
  })

  function render() {
    const focus = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          CommunityWsReconnectBoundary,
          null,
          React.createElement("button", { type: "button" }, "Underlying action"),
        ),
        { createNodeMock: () => ({ focus }) },
      )
    })
    return { renderer, focus }
  }

  it("leaves connected content interactive without rendering an overlay", () => {
    const { renderer } = render()
    const content = renderer.root.findByProps({ className: "contents" })
    expect(content.props.inert).toBeUndefined()
    expect(content.props["aria-hidden"]).toBeUndefined()
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsReconnectOverlay }))
      .toHaveLength(0)
  })

  it("blocks the content and announces a reconnecting state", () => {
    const { renderer, focus } = render()
    act(() => useCommunityWsStore.getState().setConnectionStatus("reconnecting"))

    const content = renderer.root.findByProps({ className: "contents" })
    expect(content.props).toMatchObject({ inert: true, "aria-hidden": true })
    const overlay = renderer.root.findByProps({ "data-testid": tid.wsReconnectOverlay })
    expect(overlay.props).toMatchObject({
      "data-ws-status": "reconnecting",
      "aria-modal": "true",
      role: "dialog",
      tabIndex: -1,
    })
    expect(overlay.props.className).toContain("fixed inset-0")
    expect(overlay.props.className).toContain("community-ws-reconnect-overlay")
    expect(overlay.props.className).toContain("z-2147483647")
    expect(overlay.props.className).toContain("backdrop-blur-sm")
    expect(renderer.root.findByProps({ role: "status" }).props).toMatchObject({
      "aria-atomic": "true",
      "aria-live": "polite",
    })
    expect(renderer.root.findByType("h2").children).toEqual(["Connecting…"])
    const motion = renderer.root.findByProps({ "data-connecting-motion": "" })
    expect(motion.props.className).toContain("community-ws-connecting-loader")
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsRetry })).toHaveLength(0)
    expect(focus).toHaveBeenCalledOnce()
  })

  it("shows an accessible mobile-sized Retry action and restores immediately", () => {
    const reconnectNow = vi.fn()
    useCommunityWsStore.getState().bindReconnectNow(reconnectNow)
    const { renderer } = render()
    act(() => useCommunityWsStore.getState().setConnectionStatus("failed"))

    expect(renderer.root.findByProps({ role: "alert" }).props).toMatchObject({
      "aria-atomic": "true",
      "aria-live": "assertive",
    })
    expect(renderer.root.findByType("h2").children).toEqual(["Connection lost"])
    const retry = renderer.root.findByProps({ "data-testid": tid.wsRetry })
    expect(retry.props.className).toContain("h-11")
    expect(retry.props.className).toContain("sm:h-10")
    act(() => retry.props.onClick())
    expect(reconnectNow).toHaveBeenCalledOnce()

    act(() => useCommunityWsStore.getState().setConnectionStatus("connected"))
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsReconnectOverlay }))
      .toHaveLength(0)
    expect(renderer.root.findByProps({ className: "contents" }).props.inert).toBeUndefined()
  })
})
