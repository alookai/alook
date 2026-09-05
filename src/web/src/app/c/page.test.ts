import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  resolve: vi.fn(() => "/c/me/machines"),
  userId: "user-a",
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: mocks.userId }),
}))
vi.mock("@/components/community/shell/community-session-pending-frame", () => ({
  CommunitySessionPendingFrame: (props: Record<string, unknown>) => (
    createElement("community-session-pending-frame", props)
  ),
}))
vi.mock("@/lib/community/last-community-route", () => ({
  resolveCommunityColdEntryDestination: (args: unknown) => mocks.resolve(args),
}))

import CommunityIndex from "./page"

describe("CommunityIndex", () => {
  beforeEach(() => {
    mocks.replace.mockClear()
    mocks.resolve.mockClear()
    mocks.resolve.mockReturnValue("/c/me/machines")
    mocks.userId = "user-a"
    vi.stubGlobal("window", {
      location: { pathname: "/c", search: "", hash: "" },
    })
  })

  it.each([
    "/c/channels/server-1/channel-1",
    "/c/me/dm-1",
    "/c/me/bots",
    "/c/me/machines",
  ])("replaces the root exactly once with %s", (destination) => {
    mocks.resolve.mockReturnValue(destination)
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(CommunityIndex))
    })
    expect(mocks.resolve).toHaveBeenCalledWith({
      accountId: "user-a",
      pathname: "/c",
      search: "",
      hash: "",
    })
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith(destination)
    expect(renderer.root.findByType("community-session-pending-frame").props.pathname)
      .toBe("/c")
  })

  it("passes query and hash state to the exact-root gate", () => {
    vi.stubGlobal("window", {
      location: { pathname: "/c", search: "?ref=message", hash: "#context" },
    })
    act(() => {
      TestRenderer.create(createElement(CommunityIndex))
    })
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      search: "?ref=message",
      hash: "#context",
    }))
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/machines")
  })
})
