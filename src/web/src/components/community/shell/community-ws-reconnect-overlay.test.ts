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
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          CommunityWsReconnectBoundary,
          null,
          React.createElement("button", { type: "button" }, "Underlying action"),
        ),
      )
    })
    return { renderer }
  }

  it("leaves connected content interactive without rendering an overlay", () => {
    const { renderer } = render()
    const content = renderer.root.findByProps({ className: "contents" })
    expect(content.props.inert).toBeUndefined()
    expect(content.props["aria-hidden"]).toBeUndefined()
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsReconnectOverlay }))
      .toHaveLength(0)
  })

  it("keeps covered content interactive and announces a reconnecting state", () => {
    const { renderer } = render()
    act(() => useCommunityWsStore.getState().setConnectionStatus("reconnecting"))

    const content = renderer.root.findByProps({ className: "contents" })
    expect(content.props.inert).toBeUndefined()
    expect(content.props["aria-hidden"]).toBeUndefined()
    const overlay = renderer.root.findByProps({ "data-testid": tid.wsReconnectOverlay })
    expect(overlay.props).toMatchObject({
      "data-ws-status": "reconnecting",
    })
    expect(overlay.props.role).toBeUndefined()
    expect(overlay.props["aria-modal"]).toBeUndefined()
    expect(overlay.props.className).toContain("pointer-events-none")
    expect(overlay.props.className).toContain("community-ws-reconnect-overlay")
    expect(overlay.props.className).toContain("z-2147483647")
    expect(renderer.root.findByProps({ role: "status" }).children).toEqual(["Reconnecting…"])
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsRetry })).toHaveLength(0)
  })

  it("shows a non-modal Retry action without hiding covered content", () => {
    const reconnectNow = vi.fn()
    useCommunityWsStore.getState().bindReconnectNow(reconnectNow)
    const { renderer } = render()
    act(() => useCommunityWsStore.getState().setConnectionStatus("failed"))

    expect(renderer.root.findByProps({ role: "alert" }).props).toMatchObject({
      "aria-live": "assertive",
    })
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["Realtime unavailable"])
    const retry = renderer.root.findByProps({ "data-testid": tid.wsRetry })
    expect(renderer.root.findByProps({ className: "contents" }).props.inert).toBeUndefined()
    act(() => retry.props.onClick())
    expect(reconnectNow).toHaveBeenCalledOnce()

    act(() => useCommunityWsStore.getState().setConnectionStatus("connected"))
    expect(renderer.root.findAllByProps({ "data-testid": tid.wsReconnectOverlay }))
      .toHaveLength(0)
    expect(renderer.root.findByProps({ className: "contents" }).props.inert).toBeUndefined()
  })
})
