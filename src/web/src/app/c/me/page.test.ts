import { createElement } from "react"
// @ts-expect-error react-test-renderer intentionally has no local declaration package.
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  breakpoint: "unknown" as "unknown" | "desktop" | "mobile",
  lastLeaf: null as string | null,
  onboarding: null as { status: "active"; stage: "harness" } | null,
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
  CommunityPendingFrame: (props: Record<string, unknown>) => createElement("pending-frame", props),
}))

import MeListPage from "./page"

describe("MeListPage", () => {
  beforeEach(() => {
    mocks.breakpoint = "unknown"
    mocks.lastLeaf = null
    mocks.onboarding = null
    mocks.replace.mockClear()
  })

  it.each(["unknown", "mobile"] as const)("keeps %s on the canonical list root", (breakpoint) => {
    mocks.breakpoint = breakpoint
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(MeListPage))
    })
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(renderer.toJSON()).toBeNull()
  })

  it("replaces desktop with remembered leaf while keeping its pending module mounted", () => {
    mocks.breakpoint = "desktop"
    mocks.lastLeaf = "dm-last"
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(MeListPage))
    })
    expect(mocks.replace).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/dm-last")
    expect(renderer.root.findByType("pending-frame").props.href).toBe("/c/me/dm-last")
  })

  it("defaults desktop to Friends", () => {
    mocks.breakpoint = "desktop"
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(MeListPage))
    })
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/friends")
    expect(renderer.root.findByType("pending-frame").props.href).toBe("/c/me/friends")
  })

  it("keeps desktop on the canonical root while onboarding is active", () => {
    mocks.breakpoint = "desktop"
    mocks.onboarding = { status: "active", stage: "harness" }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(MeListPage))
    })
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(renderer.toJSON()).toBeNull()
  })
})
