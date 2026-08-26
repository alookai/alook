import { createElement } from "react"
// @ts-expect-error react-test-renderer intentionally has no local declaration package.
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("./dm-header", () => ({
  DmHeaderSkeleton: (props: Record<string, unknown>) => createElement("dm-header-skeleton", props),
}))
vi.mock("@/components/community/messages/message-list", () => ({
  MessageList: (props: Record<string, unknown>) => createElement("message-list", props),
}))
vi.mock("@/components/community/messages/composer", () => ({
  ComposerSkeleton: () => createElement("composer-skeleton"),
}))

import { DmLoadingFrame } from "./dm-loading-frame"

describe("DmLoadingFrame", () => {
  it("uses DM header, message, and composer skeletons", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(DmLoadingFrame, { reserveBackSlot: true }))
    })
    expect(renderer.root.findByType("dm-header-skeleton").props.onBack).toBeTypeOf("function")
    expect(renderer.root.findByType("message-list").props).toMatchObject({ loading: true, variant: "dm" })
    expect(renderer.root.findAllByType("composer-skeleton")).toHaveLength(1)
    expect(renderer.root.findByProps({ "aria-label": "Loading direct message" }).props["aria-busy"]).toBe("true")
  })
})
