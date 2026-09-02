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
  it("composes canonical detail zones with mobile Back loading geometry", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(ChannelLoadingFrame))
    })

    expect(renderer.root.findByType("channel-header-skeleton").props).toEqual({})
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

})
