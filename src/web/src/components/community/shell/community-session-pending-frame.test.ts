import { createElement } from "react"
// @ts-expect-error react-test-renderer intentionally has no local declaration package.
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => createElement("skeleton", props),
}))

import { CommunitySessionPendingFrame } from "./community-session-pending-frame"

describe("CommunitySessionPendingFrame", () => {
  it("renders a stable inert viewport without community controls", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(CommunitySessionPendingFrame))
    })
    const frame = renderer.root.findByProps({ "aria-label": "Loading community" })
    expect(frame.props["aria-busy"]).toBe("true")
    expect(renderer.root.findAllByType("skeleton").length).toBeGreaterThan(5)
    expect(renderer.root.findAllByType("button")).toEqual([])
    expect(renderer.root.findAllByType("a")).toEqual([])
  })
})
