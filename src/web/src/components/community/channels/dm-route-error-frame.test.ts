import { createElement } from "react"
// @ts-expect-error react-test-renderer intentionally has no local declaration package.
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("lucide-react", () => ({ AlertCircle: () => createElement("alert-icon") }))
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) =>
    createElement("button", props, children),
}))
vi.mock("./dm-header", () => ({
  DmHeaderSkeleton: (props: Record<string, unknown>) => createElement("dm-header-skeleton", props),
}))
vi.mock("@/components/community/messages/composer", () => ({
  ComposerSkeleton: () => createElement("composer-skeleton"),
}))

import { DmRouteErrorFrame } from "./dm-route-error-frame"

describe("DmRouteErrorFrame", () => {
  it("retries locally and disables the action while retrying", () => {
    const retry = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(DmRouteErrorFrame, { onRetry: retry, retrying: false }))
    })
    const button = renderer.root.findByType("button")
    act(() => button.props.onClick())
    expect(retry).toHaveBeenCalledTimes(1)

    act(() => {
      renderer.update(createElement(DmRouteErrorFrame, { onRetry: retry, retrying: true }))
    })
    expect(renderer.root.findByType("button").props.disabled).toBe(true)
    expect(renderer.root.findByProps({ role: "alert" })).toBeDefined()
  })
})
