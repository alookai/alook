import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"

vi.mock("@/components/community/shell/community-pending-frame", () => ({
  CommunityPendingFrame: ({ href }: { href: string }) => createElement("div", {
    "data-testid": "pending-frame",
    "data-href": href,
  }),
}))
vi.mock("@/components/community/channels/dm-loading-frame", () => ({
  DmLoadingFrame: () => createElement("div", { "data-testid": "dm-loading-frame" }),
}))

import MeLoading from "./loading"
import FriendsLoading from "./friends/loading"
import MachinesLoading from "./machines/loading"
import BotsLoading from "./bots/loading"
import DmLoading from "./[dmId]/loading"

function hrefFor(Component: () => React.ReactNode) {
  const rendered = render(createElement(Component))
  const href = rendered.container.querySelector('[data-testid="pending-frame"]')
    ?.getAttribute("data-href")
  rendered.unmount()
  return href
}

describe("Me route loading boundaries", () => {
  it("assigns the root and static leaves their own pending href", () => {
    expect(hrefFor(MeLoading)).toBe("/c/me")
    expect(hrefFor(FriendsLoading)).toBe("/c/me/friends")
    expect(hrefFor(MachinesLoading)).toBe("/c/me/machines")
    expect(hrefFor(BotsLoading)).toBe("/c/me/bots")
  })

  it("uses the dedicated DM loading frame for a dynamic leaf", () => {
    render(createElement(DmLoading))

    expect(screen.getByTestId("dm-loading-frame")).toBeInTheDocument()
    expect(screen.queryByTestId("pending-frame")).not.toBeInTheDocument()
  })
})
