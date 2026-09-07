import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"

vi.mock("@/components/community/machines/machine-list", () => ({
  MachineListSkeleton: ({ reserveBackSlot }: { reserveBackSlot?: boolean }) => createElement("div", {
    "data-testid": "machine-skeleton",
    "data-reserve-back-slot": String(Boolean(reserveBackSlot)),
  }),
}))
vi.mock("@/components/community/bots/bot-list-view", () => ({
  BotListSkeleton: ({ reserveBackSlot }: { reserveBackSlot?: boolean }) => createElement("div", {
    "data-testid": "bot-skeleton",
    "data-reserve-back-slot": String(Boolean(reserveBackSlot)),
  }),
}))
vi.mock("@/components/community/social/friends-page", () => ({
  FriendsPage: (props: Record<string, unknown>) => createElement("div", {
    "data-testid": "friends-skeleton",
    "data-props": JSON.stringify(props),
  }),
}))
vi.mock("@/components/community/channels/dm-loading-frame", () => ({
  DmLoadingFrame: ({ reserveBackSlot }: { reserveBackSlot?: boolean }) => createElement("div", {
    "data-testid": "dm-skeleton",
    "data-reserve-back-slot": String(Boolean(reserveBackSlot)),
  }),
}))
vi.mock("@/components/community/channels/conversation-resolution-pending-frame", () => ({
  ConversationResolutionPendingFrame: () => createElement("main", {
    "data-testid": "conversation-resolution",
    "aria-label": "Resolving conversation",
    "aria-busy": "true",
  }),
}))
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => createElement("div", { "data-testid": "skeleton" }),
}))

import { CommunityPendingFrame } from "./community-pending-frame"

function renderFrame(href: string, reserveBackSlot = true) {
  return render(createElement(CommunityPendingFrame, { href, reserveBackSlot }))
}

describe("CommunityPendingFrame", () => {
  it("suppresses the outer mobile transition for every route-pending frame", () => {
    for (const href of ["/c/me", "/c/me/dm_1", "/c/me/machines", "/c/channels/s1", "/c/channels/s1/c1"]) {
      const rendered = renderFrame(href)
      expect(rendered.container.querySelector('[data-community-mobile-transition="suppress"]'))
        .toBeInTheDocument()
      rendered.unmount()
    }
  })

  it.each([
    ["/c", "route-resolution", "Resolving community route"],
    ["/c/me", "me-root", "Loading your space"],
    ["/c/channels/s1", "server-landing", "Loading server"],
    ["/c/channels/s1/settings", "server-landing", "Loading server"],
    ["/c/channels/s1/c1", "server-conversation", "Resolving conversation"],
    ["/c/me/not%5Cdm", "route-resolution", "Resolving community route"],
  ])("shares one visual for unresolved %s and preserves its semantic owner", (href, kind, label) => {
    const rendered = renderFrame(href)
    expect(screen.getByLabelText(label)).toHaveAttribute("aria-busy", "true")
    expect(rendered.container.querySelector(`[data-community-main-kind="${kind}"]`))
      .toHaveAttribute("data-community-mobile-transition", "suppress")
    expect(rendered.container.querySelectorAll("header, button, a, form, textarea")).toHaveLength(0)
  })

  it.each(["/c/me/dm_1", "/c/me/machines", "/c/me/bots", "/c/me/friends"])(
    "keeps the known layout for %s", (href) => {
      const rendered = renderFrame(href)
      expect(rendered.container.querySelector('[aria-label="Resolving community route"]'))
        .not.toBeInTheDocument()
    },
  )

  it("selects destination-specific @me skeletons and reserves a non-interactive Back slot", () => {
    let rendered = renderFrame("/c/me/machines?from=shortcut")
    expect(screen.getByTestId("machine-skeleton")).toHaveAttribute("data-reserve-back-slot", "true")
    rendered.unmount()

    rendered = renderFrame("/c/me/bots")
    expect(screen.getByTestId("bot-skeleton")).toHaveAttribute("data-reserve-back-slot", "true")
    rendered.unmount()

    renderFrame("/c/me/friends#new")
    expect(JSON.parse(screen.getByTestId("friends-skeleton").dataset.props!)).toMatchObject({
      friends: [],
      pending: [],
      blocked: [],
      loading: true,
      reserveBackSlot: true,
    })
  })

  it("separates neutral Me from DM and channel mobile Back geometry", () => {
    let rendered = renderFrame("/c/me")
    expect(screen.getByLabelText("Loading your space")).toHaveAttribute("aria-busy", "true")
    rendered.unmount()

    rendered = renderFrame("/c/me/dm_1")
    expect(screen.getByTestId("dm-skeleton")).toHaveAttribute("data-reserve-back-slot", "true")
    rendered.unmount()

    rendered = renderFrame("/c/channels/s1/c1")
    expect(screen.getByTestId("conversation-resolution")).toBeInTheDocument()
    rendered.unmount()

    renderFrame("/c/channels/s1")
    expect(screen.getByLabelText("Loading server")).toHaveAttribute("aria-busy", "true")
  })

  it("uses a neutral route-resolution frame for malformed paths", () => {
    const rendered = renderFrame(["/c/channels/s1/c1", "extra"].join("/"))
    expect(screen.getByLabelText("Resolving community route")).toBeInTheDocument()
    expect(rendered.container.querySelector('[data-testid="conversation-resolution"]'))
      .not.toBeInTheDocument()
    expect(rendered.container.querySelector('[data-testid="dm-skeleton"]')).not.toBeInTheDocument()
  })
})
