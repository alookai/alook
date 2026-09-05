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
vi.mock("@/components/community/channels/conversation-resolution-pending-frame", () => ({
  ConversationResolutionPendingFrame: (props: Record<string, unknown>) =>
    createElement("conversation-resolution", props),
}))
vi.mock("@/components/community/channels/dm-loading-frame", () => ({
  DmLoadingFrame: (props: Record<string, unknown>) => createElement("dm-skeleton", props),
}))
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => createElement("skeleton", props),
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
  it("suppresses the outer mobile transition for every route-pending frame", () => {
    for (const href of ["/c/me", "/c/me/dm_1", "/c/me/machines", "/c/channels/s1", "/c/channels/s1/c1"]) {
      expect(render(href).root.findByProps({
        "data-community-mobile-transition": "suppress",
      })).toBeDefined()
    }
  })

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

  it("separates neutral Me from DM and channel mobile Back geometry", () => {
    const root = render("/c/me")
    expect(root.root.findByProps({ "aria-label": "Loading your space" }).props["aria-busy"]).toBe("true")

    const dm = render("/c/me/dm_1")
    expect(dm.root.findByType("dm-skeleton").props.reserveBackSlot).toBe(true)

    const channel = render("/c/channels/s1/c1")
    expect(channel.root.findByType("conversation-resolution").props).toEqual({})

    const serverRoot = render("/c/channels/s1")
    expect(serverRoot.root.findByProps({ "aria-label": "Loading server" }).props["aria-busy"])
      .toBe("true")
  })

  it("uses a neutral route-resolution frame for malformed paths", () => {
    const renderer = render(["/c/channels/s1/c1", "extra"].join("/"))
    expect(renderer.root.findByProps({ "aria-label": "Resolving community route" }))
      .toBeDefined()
    expect(renderer.root.findAllByType("conversation-resolution")).toHaveLength(0)
    expect(renderer.root.findAllByType("dm-skeleton")).toHaveLength(0)
  })
})
