import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearLastMeLocation,
  getLastMeLeaf,
  isRememberableMeLocation,
  lastMeLocationKey,
  pickMeLandingLocation,
  resolveMeLocationStatus,
  setLastMeLocation,
} from "./last-me-location"

describe("last-me-location", () => {
  let storage: Record<string, string>

  beforeEach(() => {
    storage = {}
    vi.unstubAllGlobals()
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { storage[key] = value }),
      removeItem: vi.fn((key: string) => { delete storage[key] }),
    })
  })

  it("uses me as the shared last-channel scope and stores only the leaf", () => {
    expect(lastMeLocationKey()).toBe("community:lastChannel:me")
    setLastMeLocation("/c/me/machines")
    expect(getLastMeLeaf()).toBe("machines")
    clearLastMeLocation()
    expect(getLastMeLeaf()).toBeNull()
  })

  it.each([
    "/c/me/friends",
    "/c/me/machines",
    "/c/me/bots",
    "/c/me/dm_123",
  ])("accepts %s", (pathname) => {
    expect(isRememberableMeLocation(pathname)).toBe(true)
  })

  it.each([
    "/c/channels/srv_1",
    "/c/me/dm_1/messages",
    "/c/me/dm_1?seq=42",
    "/c/me/machines?reconnect=1",
    "/c/me/bots#owned",
    "/c/me/",
    "/c/me",
  ])("rejects %s", (pathname) => {
    expect(isRememberableMeLocation(pathname)).toBe(false)
  })

  it("does not overwrite a valid value with a query-bearing URL", () => {
    setLastMeLocation("/c/me/bots")
    setLastMeLocation("/c/me/dm_1?seq=42")
    expect(getLastMeLeaf()).toBe("bots")
  })

  it("falls back to friends for missing or dirty memory", () => {
    expect(pickMeLandingLocation(null)).toBe("/c/me/friends")
    expect(pickMeLandingLocation("dm_1/messages")).toBe("/c/me/friends")
    expect(pickMeLandingLocation("friends")).toBe("/c/me/friends")
    expect(pickMeLandingLocation("dm_1")).toBe("/c/me/dm_1")
  })
})

describe("resolveMeLocationStatus", () => {
  it("remembers static surfaces without waiting for DMs", () => {
    expect(resolveMeLocationStatus({
      pathname: "/c/me/machines",
      dmId: undefined,
      dmRouteStatus: "idle",
    })).toBe("remember")
  })

  it("waits for an unresolved DM list", () => {
    expect(resolveMeLocationStatus({
      pathname: "/c/me/dm_1",
      dmId: "dm_1",
      dmRouteStatus: "pending",
    })).toBe("wait")
    expect(resolveMeLocationStatus({
      pathname: "/c/me/dm_1",
      dmId: "dm_1",
      dmRouteStatus: "error",
    })).toBe("wait")
  })

  it("remembers a confirmed DM and marks a missing DM stale", () => {
    expect(resolveMeLocationStatus({
      pathname: "/c/me/dm_1",
      dmId: "dm_1",
      dmRouteStatus: "present",
    })).toBe("remember")
    expect(resolveMeLocationStatus({
      pathname: "/c/me/dm_missing",
      dmId: "dm_missing",
      dmRouteStatus: "missing",
    })).toBe("stale")
  })

  it("ignores paths outside the supported me route shape", () => {
    expect(resolveMeLocationStatus({
      pathname: "/c/me/dm_1/messages",
      dmId: "dm_1",
      dmRouteStatus: "present",
    })).toBe("ignore")
  })
})
