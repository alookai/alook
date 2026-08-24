import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/community/machines/machine-list", () => ({
  MachineListSkeleton: (props: Record<string, unknown>) => createElement("machine-skeleton", props),
}))
vi.mock("@/components/community/bots/bot-list-view", () => ({
  BotListSkeleton: (props: Record<string, unknown>) => createElement("bot-skeleton", props),
}))
vi.mock("@/components/community/social/friends-page", () => ({
  FriendsPage: (props: Record<string, unknown>) => createElement("friends-skeleton", props),
}))
vi.mock("@/components/community/channels/channel-loading-frame", () => ({
  ChannelLoadingFrame: (props: Record<string, unknown>) => createElement("channel-skeleton", props),
}))

import { CommunityPendingFrame } from "./community-pending-frame"

function render(href: string, reserveBackSlot = true) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(createElement(CommunityPendingFrame, { href, reserveBackSlot }))
  })
  return renderer
}

describe("CommunityPendingFrame", () => {
  it("selects destination-specific @me skeletons and reserves a non-interactive Back slot", () => {
    const machines = render("/c/me/machines?from=shortcut")
    expect(machines.root.findByType("machine-skeleton").props).toMatchObject({
      reserveBackSlot: true,
    })
    expect(machines.root.findByType("machine-skeleton").props.onBack).toBeUndefined()

    const bots = render("/c/me/bots")
    expect(bots.root.findByType("bot-skeleton").props.reserveBackSlot).toBe(true)
    expect(bots.root.findByType("bot-skeleton").props.onBack).toBeUndefined()

    const friends = render("/c/me/friends#new")
    expect(friends.root.findByType("friends-skeleton").props).toMatchObject({
      friends: [],
      pending: [],
      blocked: [],
      loading: true,
      reserveBackSlot: true,
    })
    expect(friends.root.findByType("friends-skeleton").props.onBack).toBeUndefined()
  })

  it("uses the canonical conversation skeleton for DM and channel details", () => {
    for (const href of ["/c/me/dm_1", "/c/channels/s1/c1"] ) {
      const result = render(href)
      expect(result.root.findByType("channel-skeleton").props.reserveBackSlot).toBe(true)
      expect(result.root.findByType("channel-skeleton").props.onBack).toBeUndefined()
    }
  })
})
