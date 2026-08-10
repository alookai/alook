import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearNavigationMemory,
  readNavigationMemory,
  writeNavigationMemory,
} from "./navigation-memory"

describe("navigation-memory", () => {
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

  it("round-trips and clears a value", () => {
    writeNavigationMemory("nav:key", "/c/me/machines")
    expect(readNavigationMemory("nav:key")).toBe("/c/me/machines")
    clearNavigationMemory("nav:key")
    expect(readNavigationMemory("nav:key")).toBeNull()
  })

  it("degrades safely when storage access throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => { throw new Error("SecurityError") }),
      setItem: vi.fn(() => { throw new Error("QuotaExceededError") }),
      removeItem: vi.fn(() => { throw new Error("SecurityError") }),
    })
    expect(readNavigationMemory("nav:key")).toBeNull()
    expect(() => writeNavigationMemory("nav:key", "value")).not.toThrow()
    expect(() => clearNavigationMemory("nav:key")).not.toThrow()
  })

  it("is SSR-safe", () => {
    vi.stubGlobal("window", undefined)
    expect(readNavigationMemory("nav:key")).toBeNull()
    expect(() => writeNavigationMemory("nav:key", "value")).not.toThrow()
    expect(() => clearNavigationMemory("nav:key")).not.toThrow()
  })
})
