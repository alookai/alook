import { getCapturedRuntime, capturedQueryClient, resetCommunityWsHarness, cleanupCommunityWsHarness } from "./test-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TYPING_INDICATOR_TIMEOUT_MS } from "@alook/shared"
import { useCommunityStore } from "@/stores/community"
import {
  applyTypingIndicator,
  clearAllTypingIndicators,
  clearTypingIndicator,
  typingScopeKey,
} from "./typing"

beforeEach(async () => {
  await resetCommunityWsHarness()
  vi.useFakeTimers()
  getCapturedRuntime().ui.actions.reset()
})

afterEach(async () => {
  getCapturedRuntime().ui.actions.reset()
  await cleanupCommunityWsHarness()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("community WS typing helpers", () => {
  it("derives DM and channel scope keys from the focused subscription", () => {
    expect(typingScopeKey({ channelId: "dm_1" }, { dmConversationId: "dm_1" })).toBe("dm:dm_1")
    expect(typingScopeKey({ channelId: "ch_1" }, { channelId: "ch_1" })).toBe("ch:ch_1")
    expect(typingScopeKey({ channelId: "dm_2" }, { dmConversationId: "dm_1" })).toBe("ch:dm_2")
  })

  it("stores names and null fallback values in isolated scopes", () => {
    applyTypingIndicator(capturedQueryClient, "ch:ch_1", "u_named", "Alice")
    applyTypingIndicator(capturedQueryClient, "dm:dm_1", "u_legacy", null)

    const state = getCapturedRuntime().ui.get()
    expect(state.typingByScope.get("ch:ch_1")?.get("u_named")).toBe("Alice")
    expect(state.typingByScope.get("dm:dm_1")?.get("u_legacy")).toBeNull()
    expect(state.typingTimers.has("ch:ch_1|u_named")).toBe(true)
    expect(state.typingTimers.has("dm:dm_1|u_legacy")).toBe(true)
  })

  it("refreshes the timer without replacing an unchanged typing map", () => {
    applyTypingIndicator(capturedQueryClient, "ch:ch_1", "u_1", "Alice")
    const typingMap = getCapturedRuntime().ui.get().typingByScope
    vi.advanceTimersByTime(TYPING_INDICATOR_TIMEOUT_MS / 2)

    applyTypingIndicator(capturedQueryClient, "ch:ch_1", "u_1", "Alice")

    expect(getCapturedRuntime().ui.get().typingByScope).toBe(typingMap)
    vi.advanceTimersByTime(TYPING_INDICATOR_TIMEOUT_MS - 1)
    expect(getCapturedRuntime().ui.get().typingByScope.get("ch:ch_1")?.has("u_1")).toBe(true)
    vi.advanceTimersByTime(1)
    expect(getCapturedRuntime().ui.get().typingByScope.get("ch:ch_1")).toBeUndefined()
  })

  it("expires one typer without disturbing another in the same scope", () => {
    applyTypingIndicator(capturedQueryClient, "ch:ch_1", "u_1", "One")
    vi.advanceTimersByTime(1000)
    applyTypingIndicator(capturedQueryClient, "ch:ch_1", "u_2", "Two")

    vi.advanceTimersByTime(TYPING_INDICATOR_TIMEOUT_MS - 1000)

    const state = getCapturedRuntime().ui.get()
    expect(state.typingByScope.get("ch:ch_1")?.has("u_1")).toBe(false)
    expect(state.typingByScope.get("ch:ch_1")?.get("u_2")).toBe("Two")
    expect(state.typingTimers.has("ch:ch_1|u_1")).toBe(false)
    expect(state.typingTimers.has("ch:ch_1|u_2")).toBe(true)
  })

  it("clears timers and deletes a scope only after its last typer leaves", () => {
    applyTypingIndicator(capturedQueryClient, "dm:dm_1", "u_1", "One")
    applyTypingIndicator(capturedQueryClient, "dm:dm_1", "u_2", "Two")

    clearTypingIndicator(capturedQueryClient, "dm:dm_1", "u_1")
    expect(getCapturedRuntime().ui.get().typingByScope.get("dm:dm_1")?.has("u_1")).toBe(false)
    expect(getCapturedRuntime().ui.get().typingByScope.get("dm:dm_1")?.has("u_2")).toBe(true)
    expect(getCapturedRuntime().ui.get().typingTimers.has("dm:dm_1|u_1")).toBe(false)

    clearTypingIndicator(capturedQueryClient, "dm:dm_1", "u_2")
    expect(getCapturedRuntime().ui.get().typingByScope.get("dm:dm_1")).toBeUndefined()
    expect(getCapturedRuntime().ui.get().typingTimers.has("dm:dm_1|u_2")).toBe(false)
  })

  it("cancels every timer before clearing all scopes and is idempotent", () => {
    applyTypingIndicator(capturedQueryClient, "ch:one", "u_1", "One")
    applyTypingIndicator(capturedQueryClient, "dm:two", "u_2", "Two")
    const clear = vi.spyOn(globalThis, "clearTimeout")

    clearAllTypingIndicators(capturedQueryClient, )

    expect(clear).toHaveBeenCalledTimes(2)
    expect(getCapturedRuntime().ui.get().typingByScope.size).toBe(0)
    expect(getCapturedRuntime().ui.get().typingTimers.size).toBe(0)
    clearAllTypingIndicators(capturedQueryClient, )
    expect(clear).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(TYPING_INDICATOR_TIMEOUT_MS)
    expect(getCapturedRuntime().ui.get().typingByScope.size).toBe(0)
  })
})
