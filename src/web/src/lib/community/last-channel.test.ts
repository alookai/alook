import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  lastChannelKey,
  getLastChannel,
  setLastChannel,
  clearLastChannel,
  pickServerLandingHref,
  resolveCommunityLandingHref,
} from "./last-channel"

describe("last-channel", () => {
  let storage: Record<string, string>

  it.each([
    [null, "dm_1", "desktop", "/c/me/dm_1"],
    [null, "bots", "desktop", "/c/me/bots"],
    [null, null, "desktop", "/c/me/friends"],
    [null, "dm_1", "mobile", "/c/me"],
    [null, "dm_1", "unknown", "/c/me"],
    ["server", "child", "desktop", "/c/channels/server/child"],
    ["server", null, "desktop", "/c/channels/server/first"],
    ["server", "child", "mobile", "/c/channels/server"],
    ["server", "child", "unknown", "/c/channels/server"],
    [null, "../dm", "desktop", "/c/me/friends"],
    ["server", "child?msg=42", "desktop", "/c/channels/server/first"],
    ["server", "child#marker", "desktop", "/c/channels/server/first"],
    ["server", "..", "desktop", "/c/channels/server/first"],
  ] as const)("resolves scope %s and leaf %s for %s", (serverId, last, breakpoint, expected) => {
    expect(resolveCommunityLandingHref({ serverId, last, breakpoint, channelIds: ["first"] })).toBe(expected)
  })

  beforeEach(() => {
    storage = {}
    vi.unstubAllGlobals()
    vi.stubGlobal("window", new EventTarget())
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage[key] = value
      }),
      removeItem: vi.fn((key: string) => {
        delete storage[key]
      }),
    })
  })

  it("namespaces the key under the last-channel prefix", () => {
    expect(lastChannelKey("srv_1")).toBe("community:lastChannel:srv_1")
  })

  it("returns null when nothing is stored for the server", () => {
    expect(getLastChannel("srv_1")).toBeNull()
  })

  it("round-trips a channel id per server", () => {
    setLastChannel("srv_1", "ch_9")
    setLastChannel("srv_2", "ch_3")
    expect(getLastChannel("srv_1")).toBe("ch_9")
    expect(getLastChannel("srv_2")).toBe("ch_3")
  })

  it("overwrites the prior channel for the same server", () => {
    setLastChannel("srv_1", "ch_1")
    setLastChannel("srv_1", "ch_2")
    expect(getLastChannel("srv_1")).toBe("ch_2")
  })

  it("clears a deployed parent/child value on read", () => {
    storage[lastChannelKey("srv_1")] = "parent_1/child_1"
    expect(getLastChannel("srv_1")).toBeNull()
    expect(storage[lastChannelKey("srv_1")]).toBeUndefined()
  })

  it("rejects a future slash write and clears the prior valid value", () => {
    setLastChannel("srv_1", "child_1")
    setLastChannel("srv_1", "parent_1/child_1")
    expect(getLastChannel("srv_1")).toBeNull()
    expect(storage[lastChannelKey("srv_1")]).toBeUndefined()
  })

  it("returns null (never throws) when localStorage.getItem throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => {
        throw new Error("SecurityError: localStorage unavailable")
      }),
      setItem: vi.fn(),
    })
    expect(getLastChannel("srv_1")).toBeNull()
  })

  it("swallows a throwing localStorage.setItem (best-effort, no throw)", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error("QuotaExceededError")
      }),
    })
    expect(() => setLastChannel("srv_1", "ch_1")).not.toThrow()
  })

  it("is a no-op returning null under SSR (no window)", () => {
    vi.stubGlobal("window", undefined)
    expect(getLastChannel("srv_1")).toBeNull()
    expect(() => setLastChannel("srv_1", "ch_1")).not.toThrow()
  })

  it("clearLastChannel forgets the remembered id (redirect-loop breaker)", () => {
    setLastChannel("srv_1", "post_dead")
    setLastChannel("srv_2", "ch_keep")
    clearLastChannel("srv_1")
    expect(getLastChannel("srv_1")).toBeNull() // dead id gone → next landing picks default
    expect(getLastChannel("srv_2")).toBe("ch_keep") // other servers untouched
  })

  it("clearLastChannel swallows a throwing removeItem and is a no-op under SSR", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(() => {
        throw new Error("SecurityError")
      }),
    })
    expect(() => clearLastChannel("srv_1")).not.toThrow()
    vi.stubGlobal("window", undefined)
    expect(() => clearLastChannel("srv_1")).not.toThrow()
  })
})

describe("pickServerLandingHref", () => {
  it("rejects a superseded parent/child leaf and falls back safely", () => {
    expect(pickServerLandingHref("srv_1", ["ch_1"], "forum_1/post_1")).toBe(
      "/c/channels/srv_1/ch_1",
    )
  })

  it("lands directly on a remembered child thread without top-level validation", () => {
    expect(pickServerLandingHref("srv_1", ["ch_1"], "post_1")).toBe(
      "/c/channels/srv_1/post_1",
    )
  })

  it("uses a cached default leaf and only falls back to the root when none exists", () => {
    expect(pickServerLandingHref("srv_1", ["ch_1", "ch_2"], null)).toBe(
      "/c/channels/srv_1/ch_1",
    )
    expect(pickServerLandingHref("srv_1", [], null)).toBe("/c/channels/srv_1")
  })
})
