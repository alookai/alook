import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  lastChannelKey,
  getLastChannel,
  setLastChannel,
  clearLastChannel,
  pickServerLandingChannel,
  pickServerLandingHref,
} from "./last-channel"

describe("last-channel", () => {
  let storage: Record<string, string>

  beforeEach(() => {
    storage = {}
    vi.unstubAllGlobals()
    vi.stubGlobal("window", {})
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

describe("pickServerLandingChannel", () => {
  it("restores the remembered last channel (returned directly, not validated against the list)", () => {
    expect(pickServerLandingChannel(["ch_1", "ch_2", "ch_3"], "ch_2")).toBe("ch_2")
  })

  it("restores a remembered id that is NOT in the top-level list — a forum post / thread (the bug this fixes)", () => {
    // A post/thread is a child channel: its id never appears in the top-level
    // list, so the old `includes` gate dropped it and always fell to default.
    // Now it's returned directly; the destination page renders the post opener.
    expect(pickServerLandingChannel(["ch_1", "ch_2"], "post_abc")).toBe("post_abc")
  })

  it("falls back to the first top-level channel when there is no memory", () => {
    expect(pickServerLandingChannel(["ch_1", "ch_2"], null)).toBe("ch_1")
  })

  it("returns a dirty/garbage remembered id as-is — validity is the destination's job (its meta fetch 404/403 → bounce to default)", () => {
    // "Trust the id" ≠ "trust the id is valid". A localStorage value hand-edited
    // or written stale by another tab still navigates; the destination page's
    // 404||403 bounce degrades it to default (Blondie/Melly's dirty-last check).
    expect(pickServerLandingChannel(["ch_1", "ch_2"], "garbage_id")).toBe("garbage_id")
  })

  it("returns undefined only when there's no memory AND no channels; a remembered id wins even over an empty list", () => {
    expect(pickServerLandingChannel([], null)).toBeUndefined()
    // With memory, the id is returned even if the top-level list is empty (the
    // remembered channel may be a child channel under a forum, not top-level).
    expect(pickServerLandingChannel([], "post_abc")).toBe("post_abc")
  })
})

describe("pickServerLandingHref", () => {
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
