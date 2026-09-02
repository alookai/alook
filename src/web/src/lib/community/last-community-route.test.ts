import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  COMMUNITY_COLD_ENTRY_FALLBACK,
  canonicalCommunityLeafPathname,
  clearCommunityColdEntryAttempts,
  commitLastCommunityRoute,
  consumeCommunityColdEntryFailure,
  getLastCommunityRoute,
  lastCommunityRouteKey,
  retireCommunityColdEntryAttempt,
  resolveCommunityColdEntryDestination,
} from "./last-community-route"

describe("last-community-route", () => {
  let storage: Record<string, string>

  beforeEach(() => {
    storage = {}
    clearCommunityColdEntryAttempts()
    vi.unstubAllGlobals()
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { storage[key] = value }),
      removeItem: vi.fn((key: string) => { delete storage[key] }),
    })
  })

  it("keeps route memory account-scoped", () => {
    expect(lastCommunityRouteKey("user/a")).toBe("community:lastRoute:user%2Fa")
    expect(getLastCommunityRoute("")).toBeNull()
    commitLastCommunityRoute("user-a", "/c/me/bots")
    commitLastCommunityRoute("user-b", "/c/me/machines")
    expect(getLastCommunityRoute("user-a")).toBe("/c/me/bots")
    expect(getLastCommunityRoute("user-b")).toBe("/c/me/machines")
  })

  it.each([
    ["/c/me/friends", "/c/me/friends"],
    ["/c/me/machines?reconnect=1#daemon", "/c/me/machines"],
    ["/c/me/bots#owned", "/c/me/bots"],
    ["/c/me/dm_1?seq=42", "/c/me/dm_1"],
    ["/c/channels/server_1/channel_1?msg=message_1", "/c/channels/server_1/channel_1"],
  ])("canonicalizes a supported leaf %s", (href, expected) => {
    expect(canonicalCommunityLeafPathname(href)).toBe(expected)
  })

  it.each([
    "/c",
    "/c/me",
    "/c/channels/server_1",
    "/c/channels/server_1/settings",
    "/c/invite/token",
    "/sign-in",
  ])("rejects non-leaf or excluded route %s", (href) => {
    expect(canonicalCommunityLeafPathname(href)).toBeNull()
  })

  it("stores only the canonical pathname and ignores unsupported commits", () => {
    expect(commitLastCommunityRoute("user-a", "/c/me/dm_1?seq=42#context"))
      .toBe("/c/me/dm_1")
    expect(storage[lastCommunityRouteKey("user-a")]).toBe("/c/me/dm_1")
    expect(commitLastCommunityRoute("user-a", "/c/me")).toBeNull()
    expect(storage[lastCommunityRouteKey("user-a")]).toBe("/c/me/dm_1")
  })

  it("repairs a query-bearing supported value and clears an invalid value", () => {
    storage[lastCommunityRouteKey("user-a")] = "/c/me/bots?temporary=1"
    expect(getLastCommunityRoute("user-a")).toBe("/c/me/bots")
    expect(storage[lastCommunityRouteKey("user-a")]).toBe("/c/me/bots")

    storage[lastCommunityRouteKey("user-a")] = "/c/invite/token"
    expect(getLastCommunityRoute("user-a")).toBeNull()
    expect(storage[lastCommunityRouteKey("user-a")]).toBeUndefined()
  })

  it("reads memory only for the exact community root", () => {
    commitLastCommunityRoute("user-a", "/c/me/friends")
    const getItem = vi.mocked(localStorage.getItem)
    getItem.mockClear()

    expect(resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c", search: "?ref=1", hash: "",
    })).toBe(COMMUNITY_COLD_ENTRY_FALLBACK)
    expect(resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c", search: "", hash: "#ref",
    })).toBe(COMMUNITY_COLD_ENTRY_FALLBACK)
    expect(resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c/me", search: "", hash: "",
    })).toBe(COMMUNITY_COLD_ENTRY_FALLBACK)
    expect(getItem).not.toHaveBeenCalled()

    expect(resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c", search: "", hash: "",
    })).toBe("/c/me/friends")
    expect(getItem).toHaveBeenCalledTimes(1)
  })

  it("falls back when exact root has no valid memory", () => {
    expect(resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c", search: "", hash: "",
    })).toBe(COMMUNITY_COLD_ENTRY_FALLBACK)
  })

  it("clears only the matching account's one-shot failed restoration", () => {
    commitLastCommunityRoute("user-a", "/c/me/dm_missing")
    commitLastCommunityRoute("user-b", "/c/me/bots")
    resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c", search: "", hash: "",
    })

    expect(consumeCommunityColdEntryFailure("user-b", "/c/me/bots")).toBe(false)
    expect(consumeCommunityColdEntryFailure("user-a", "/c/me/other")).toBe(false)
    expect(consumeCommunityColdEntryFailure("user-a", "/c/me/dm_missing")).toBe(true)
    expect(getLastCommunityRoute("user-a")).toBeNull()
    expect(getLastCommunityRoute("user-b")).toBe("/c/me/bots")
    expect(consumeCommunityColdEntryFailure("user-a", "/c/me/dm_missing")).toBe(false)
  })

  it("a verified commit ends the active restore attempt", () => {
    commitLastCommunityRoute("user-a", "/c/me/dm_1")
    resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c", search: "", hash: "",
    })
    commitLastCommunityRoute("user-a", "/c/me/friends")
    expect(consumeCommunityColdEntryFailure("user-a", "/c/me/dm_1")).toBe(false)
    expect(getLastCommunityRoute("user-a")).toBe("/c/me/friends")
  })

  it("retires an abandoned pending restore before a later ordinary deep link", () => {
    commitLastCommunityRoute("user-a", "/c/me/dm_missing")
    resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c", search: "", hash: "",
    })

    expect(retireCommunityColdEntryAttempt("user-a", "/c")).toBe(false)
    expect(retireCommunityColdEntryAttempt("user-a", "/c/me/dm_missing?pending=1"))
      .toBe(false)
    expect(retireCommunityColdEntryAttempt("user-a", "/c/me")).toBe(true)
    expect(retireCommunityColdEntryAttempt("user-a", "/c/me")).toBe(false)
    delete storage[lastCommunityRouteKey("user-a")]

    expect(consumeCommunityColdEntryFailure("user-a", "/c/me/dm_missing")).toBe(false)
  })

  it("retires an abandoned restore when a later exact root has no memory", () => {
    commitLastCommunityRoute("user-a", "/c/me/dm_missing")
    resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c", search: "", hash: "",
    })
    delete storage[lastCommunityRouteKey("user-a")]

    expect(resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c", search: "", hash: "",
    })).toBe(COMMUNITY_COLD_ENTRY_FALLBACK)
    expect(consumeCommunityColdEntryFailure("user-a", "/c/me/dm_missing")).toBe(false)
  })

  it("degrades without throwing when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => { throw new Error("blocked") }),
      setItem: vi.fn(() => { throw new Error("blocked") }),
      removeItem: vi.fn(() => { throw new Error("blocked") }),
    })
    expect(() => commitLastCommunityRoute("user-a", "/c/me/friends")).not.toThrow()
    expect(getLastCommunityRoute("user-a")).toBeNull()
    expect(resolveCommunityColdEntryDestination({
      accountId: "user-a", pathname: "/c", search: "", hash: "",
    })).toBe(COMMUNITY_COLD_ENTRY_FALLBACK)
  })
})
