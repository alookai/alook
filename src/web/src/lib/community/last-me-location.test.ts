import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearLastMeLocation,
  getLastMeLeaf,
  isRememberableMeLocation,
  lastMeLocationKey,
  pickMeLandingLocation,
  setLastMeLocation,
} from "./last-me-location"

describe("last-me-location", () => {
  let storage: Record<string, string>

  beforeEach(() => {
    storage = {}
    vi.unstubAllGlobals()
    vi.stubGlobal("window", new EventTarget())
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
    "/c/me/%E0%A4%A",
  ])("rejects %s", (pathname) => {
    expect(isRememberableMeLocation(pathname)).toBe(false)
  })

  it("does not overwrite a valid value with a query-bearing URL", () => {
    setLastMeLocation("/c/me/bots")
    setLastMeLocation("/c/me/dm_1?seq=42")
    expect(getLastMeLeaf()).toBe("bots")
  })

  it("retains a valid destination when decoding a damaged URI fails", () => {
    setLastMeLocation("/c/me/bots")
    expect(() => setLastMeLocation("/c/me/%")).not.toThrow()
    expect(getLastMeLeaf()).toBe("bots")
  })

  it("falls back to friends for missing or dirty memory", () => {
    expect(pickMeLandingLocation(null)).toBe("/c/me/friends")
    expect(pickMeLandingLocation("dm_1/messages")).toBe("/c/me/friends")
    expect(pickMeLandingLocation("friends")).toBe("/c/me/friends")
    expect(pickMeLandingLocation("dm_1")).toBe("/c/me/dm_1")
  })
})
