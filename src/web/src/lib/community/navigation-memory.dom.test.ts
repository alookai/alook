import { act } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearNavigationMemory, subscribeNavigationMemory, writeNavigationMemory } from "./navigation-memory"

beforeEach(() => localStorage.clear())

describe("navigation memory notification", () => {
  it("notifies once after successful changes and stops after unsubscribe", () => {
    const notify = vi.fn(() => localStorage.getItem("nav"))
    const unsubscribe = subscribeNavigationMemory(notify)
    act(() => writeNavigationMemory("nav", "bots"))
    act(() => writeNavigationMemory("nav", "bots"))
    expect(notify.mock.results.map((result) => result.value)).toEqual(["bots"])
    act(() => clearNavigationMemory("nav"))
    act(() => clearNavigationMemory("nav"))
    expect(notify.mock.results.map((result) => result.value)).toEqual(["bots", null])
    unsubscribe()
    act(() => writeNavigationMemory("nav", "machines"))
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("does not notify when a write fails", () => {
    const notify = vi.fn()
    const unsubscribe = subscribeNavigationMemory(notify)
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError") })
    expect(() => writeNavigationMemory("nav", "bots")).not.toThrow()
    expect(notify).not.toHaveBeenCalled()
    set.mockRestore()
    unsubscribe()
  })
})
