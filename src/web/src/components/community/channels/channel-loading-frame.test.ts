import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("./channel-header", () => ({
  ChannelHeaderSkeleton: (props: Record<string, unknown>) =>
    createElement("channel-header-skeleton", props),
}))
vi.mock("@/components/community/messages/message-list", () => ({
  MessageList: (props: Record<string, unknown>) => createElement("message-list", props),
}))
vi.mock("@/components/community/messages/composer", () => ({
  ComposerSkeleton: () => createElement("composer-skeleton"),
}))

import { ChannelLoadingFrame } from "./channel-loading-frame"

describe("ChannelLoadingFrame", () => {
  it("composes canonical detail zones and converts a legacy Back handler to inert geometry", () => {
    const onBack = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(ChannelLoadingFrame, { onBack }))
    })

    expect(renderer.root.findByType("channel-header-skeleton").props).toMatchObject({
      reserveBackSlot: true,
    })
    expect(renderer.root.findByType("channel-header-skeleton").props.onBack).toBeUndefined()
    expect(renderer.root.findByType("message-list").props).toMatchObject({
      channel: "",
      messages: [],
      loading: true,
    })
    expect(renderer.root.findAllByType("composer-skeleton")).toHaveLength(1)
    const tree = renderer.toJSON() as TestRenderer.ReactTestRendererJSON
    expect(tree.props).toMatchObject({
      "aria-busy": "true",
      "aria-label": "Loading conversation",
    })
  })

  it("reserves loading Back geometry without exposing an interactive handler", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(ChannelLoadingFrame, { reserveBackSlot: true }))
    })

    expect(renderer.root.findByType("channel-header-skeleton").props).toMatchObject({
      reserveBackSlot: true,
    })
    expect(renderer.root.findByType("channel-header-skeleton").props.onBack).toBeUndefined()
  })
})
