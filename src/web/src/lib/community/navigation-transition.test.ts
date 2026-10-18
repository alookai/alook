import { describe, expect, it } from "vitest"
import { COMMUNITY_NAV_BACK, COMMUNITY_NAV_FORWARD, communityNavigationTransitionTypes } from "./navigation-transition"

describe("community navigation direction", () => {
  it.each([
    ["/c/me", "/c/me/dm1"],
    ["/c/channels/s1", "/c/channels/s1/c1"],
  ])("enters a detail from a list independently of the router method: %s → %s", (from, to) => {
    expect(communityNavigationTransitionTypes(from, to)).toEqual([COMMUNITY_NAV_FORWARD])
  })

  it.each([
    ["/c/me/dm1", "/c/me", "/c/me"],
    ["/c/channels/s1/c1", "/c/channels/s1", "/c/channels/s1"],
    ["/c/channels/s1/thread1", "/c/channels/s1/c1?msg=m1", "/c/channels/s1/c1"],
  ])("returns to a semantic parent: %s → %s", (from, to, parent) => {
    expect(communityNavigationTransitionTypes(from, to, parent)).toEqual([COMMUNITY_NAV_BACK])
  })

  it.each([
    ["/c/me/dm1", "/c/me/dm2"],
    ["/c/channels/s1/c1", "/c/channels/s1/c2"],
    ["/c/channels/s1/c1", "/c/channels/s2"],
    ["/c/channels/s1", "/c/channels/s2"],
  ])("uses entry, never parent exit, for same-level and other-scope changes: %s → %s", (from, to) => {
    expect(communityNavigationTransitionTypes(from, to)).toEqual([COMMUNITY_NAV_FORWARD])
  })

  it("does not move a query-only destination or a route outside community", () => {
    expect(communityNavigationTransitionTypes("/c/me/dm1", "/c/me/dm1?msg=m1")).toEqual([])
    expect(communityNavigationTransitionTypes("/c/me", "/sign-in")).toEqual([])
  })

  it("retains an explicit child direction and an explicit no-motion override", () => {
    expect(communityNavigationTransitionTypes("/c/channels/s1/c1", "/c/channels/s1/thread1", null,
      [COMMUNITY_NAV_FORWARD])).toEqual([COMMUNITY_NAV_FORWARD])
    expect(communityNavigationTransitionTypes("/c/me", "/c/me/dm1", null, [])).toEqual([])
  })
})
