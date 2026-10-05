import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearNavigationMemory,
  readNavigationMemory,
  subscribeNavigationMemory,
  writeNavigationMemory,
} from "./navigation-memory"

describe("navigation-memory", () => {
  let storage: Record<string, string>

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
  afterEach(() => { vi.unstubAllGlobals() })

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
    const notify = vi.fn()
    const unsubscribe = subscribeNavigationMemory(notify)
    expect(() => unsubscribe()).not.toThrow()
    expect(readNavigationMemory("nav:key")).toBeNull()
    expect(() => writeNavigationMemory("nav:key", "value")).not.toThrow()
    expect(() => clearNavigationMemory("nav:key")).not.toThrow()
    expect(notify).not.toHaveBeenCalled()
    expect(localStorage.getItem).not.toHaveBeenCalled()
    expect(localStorage.setItem).not.toHaveBeenCalled()
    expect(localStorage.removeItem).not.toHaveBeenCalled()
  })

  it("notifies browser changes and native storage events only until unsubscribe", () => {
    const notify = vi.fn()
    const unsubscribe = subscribeNavigationMemory(notify)
    writeNavigationMemory("nav:key", "value")
    expect(notify).toHaveBeenCalledTimes(1)
    writeNavigationMemory("nav:key", "value")
    expect(notify).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event("storage"))
    expect(notify).toHaveBeenCalledTimes(2)
    clearNavigationMemory("nav:key")
    expect(notify).toHaveBeenCalledTimes(3)
    clearNavigationMemory("nav:key")
    expect(notify).toHaveBeenCalledTimes(3)
    unsubscribe()
    writeNavigationMemory("nav:key", "after-cleanup")
    clearNavigationMemory("nav:key")
    window.dispatchEvent(new Event("storage"))
    expect(notify).toHaveBeenCalledTimes(3)
  })
})
