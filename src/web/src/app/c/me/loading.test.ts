import { createElement } from "react"
// @ts-expect-error react-test-renderer intentionally has no local declaration package.
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/community/shell/community-pending-frame", () => ({
  CommunityPendingFrame: (props: Record<string, unknown>) => createElement("pending-frame", props),
}))
vi.mock("@/components/community/channels/dm-loading-frame", () => ({
  DmLoadingFrame: (props: Record<string, unknown>) => createElement("dm-loading-frame", props),
}))

import MeLoading from "./loading"
import FriendsLoading from "./friends/loading"
import MachinesLoading from "./machines/loading"
import BotsLoading from "./bots/loading"
import DmLoading from "./[dmId]/loading"

function hrefFor(Component: () => React.ReactNode) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(createElement(Component))
  })
  return renderer.root.findByType("pending-frame").props.href
}

describe("Me route loading boundaries", () => {
  it("assigns the root and static leaves their own pending href", () => {
    expect(hrefFor(MeLoading)).toBe("/c/me")
    expect(hrefFor(FriendsLoading)).toBe("/c/me/friends")
    expect(hrefFor(MachinesLoading)).toBe("/c/me/machines")
    expect(hrefFor(BotsLoading)).toBe("/c/me/bots")
  })

  it("uses the dedicated DM loading frame for a dynamic leaf", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(DmLoading))
    })
    expect(renderer.root.findAllByType("dm-loading-frame")).toHaveLength(1)
    expect(renderer.root.findAllByType("pending-frame")).toHaveLength(0)
  })
})
