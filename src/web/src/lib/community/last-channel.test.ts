import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  lastChannelKey,
  getLastChannel,
  setLastChannel,
  pickServerLandingChannel,
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
})

describe("pickServerLandingChannel", () => {
  it("restores the remembered last channel when it still exists", () => {
    expect(pickServerLandingChannel(["ch_1", "ch_2", "ch_3"], "ch_2")).toBe("ch_2")
  })

  it("falls back to the first channel when there is no memory", () => {
    expect(pickServerLandingChannel(["ch_1", "ch_2"], null)).toBe("ch_1")
  })

  it("falls back to the first channel when the remembered id is gone (deleted / no access)", () => {
    // The graceful fallback: a stale id simply isn't in the visible list.
    expect(pickServerLandingChannel(["ch_1", "ch_2"], "ch_deleted")).toBe("ch_1")
  })

  it("returns undefined when the server has no channels", () => {
    expect(pickServerLandingChannel([], "ch_1")).toBeUndefined()
    expect(pickServerLandingChannel([], null)).toBeUndefined()
  })
})
