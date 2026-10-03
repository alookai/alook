import { createElement, useEffect } from "react"
import { QueryClient } from "@tanstack/react-query"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  breakpoint: "unknown" as "unknown" | "desktop" | "mobile",
  lastLeaf: null as string | null,
  onboarding: null as { status: "active"; stage: "harness" } | null,
  ownerDeleteRootLanding: false,
  replace: vi.fn(),
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/lib/community-onboarding", () => ({
  useCommunityOnboarding: () => mocks.onboarding,
}))
vi.mock("@/lib/community/last-me-location", () => ({
  getLastMeLeaf: () => mocks.lastLeaf,
  pickMeLandingLocation: (leaf: string | null) => `/c/me/${leaf ?? "friends"}`,
}))
vi.mock("@/components/community/shell/community-pending-frame", () => ({
  CommunityPendingFrame: ({ href }: { href: string }) => createElement("div", {
    "data-testid": "pending-frame",
    "data-href": href,
  }),
}))

import MeListPage from "./page"

function StartOnboarding() {
  const runtime = useCommunityRuntime()
  useEffect(() => {
    runtime.ui.setState((state) => ({ ...state, onboardingState: { status: "active", stage: "harness" } }))
  }, [runtime])
  return null
}

function renderPage(startOnboarding = false) {
  const client = new QueryClient()
  const registry = createCommunityDbRegistry(client, "viewer")
  registry.runtime.serverEject.setState((state) => ({ ...state, meRootLanding: mocks.ownerDeleteRootLanding }))
  return render(createElement(CommunityTestProvider, { client },
    startOnboarding ? createElement(StartOnboarding) : null,
    createElement(MeListPage)))
}

describe("MeListPage", () => {
  beforeEach(() => {
    mocks.breakpoint = "unknown"
    mocks.lastLeaf = null
    mocks.onboarding = null
    mocks.ownerDeleteRootLanding = false
    mocks.replace.mockClear()
  })

  it.each(["unknown", "mobile"] as const)("keeps %s on the canonical list root", (breakpoint) => {
    mocks.breakpoint = breakpoint
    const rendered = renderPage()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(rendered.container).toBeEmptyDOMElement()
  })

  it("replaces desktop with remembered leaf while keeping its pending module mounted", () => {
    mocks.breakpoint = "desktop"
    mocks.lastLeaf = "dm-last"
    renderPage()
    expect(mocks.replace).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/dm-last")
    expect(screen.getByTestId("pending-frame")).toHaveAttribute("data-href", "/c/me/dm-last")
  })

  it("defaults desktop to Friends", () => {
    mocks.breakpoint = "desktop"
    renderPage()
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/friends")
    expect(screen.getByTestId("pending-frame")).toHaveAttribute("data-href", "/c/me/friends")
  })

  it("keeps an explicit owner-delete landing on the canonical root", () => {
    mocks.breakpoint = "desktop"
    mocks.ownerDeleteRootLanding = true
    const rendered = renderPage()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(rendered.container).toBeEmptyDOMElement()
  })

  it("keeps desktop on the canonical root while onboarding is active", () => {
    mocks.breakpoint = "desktop"
    mocks.onboarding = { status: "active", stage: "harness" }
    const rendered = renderPage()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(rendered.container).toBeEmptyDOMElement()
  })
  it("does not overwrite onboarding started by an earlier sibling effect", () => {
    mocks.breakpoint = "desktop"
    renderPage(true)
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
