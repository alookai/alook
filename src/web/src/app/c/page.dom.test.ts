import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"

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
    createElement("div", {
      "data-testid": "community-session-pending-frame",
      "data-pathname": props.pathname,
    })
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
    window.history.replaceState({}, "", "/c")
  })

  it.each([
    "/c/channels/server-1/channel-1",
    "/c/me/dm-1",
    "/c/me/bots",
    "/c/me/machines",
  ])("replaces the root exactly once with %s", (destination) => {
    mocks.resolve.mockReturnValue(destination)
    render(createElement(CommunityIndex))
    expect(mocks.resolve).toHaveBeenCalledWith({
      accountId: "user-a",
      pathname: "/c",
      search: "",
      hash: "",
    })
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith(destination)
    expect(screen.getByTestId("community-session-pending-frame"))
      .toHaveAttribute("data-pathname", "/c")
  })

  it("passes query and hash state to the exact-root gate", () => {
    window.history.replaceState({}, "", "/c?ref=message#context")
    render(createElement(CommunityIndex))
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      search: "?ref=message",
      hash: "#context",
    }))
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/machines")
  })
})
