import { describe, it, expect } from "vitest"
import { STATUS_PRESETS, hasStatus, matchingPreset } from "./status-presets"

describe("hasStatus", () => {
  it("false when both emoji and text are null/undefined/empty", () => {
    expect(hasStatus(null, null)).toBe(false)
    expect(hasStatus(undefined, undefined)).toBe(false)
    expect(hasStatus("", "")).toBe(false)
  })

  it("true when only emoji is set", () => {
    expect(hasStatus("🎧", null)).toBe(true)
    expect(hasStatus("🎧", "")).toBe(true)
  })

  it("true when only text is set", () => {
    expect(hasStatus(null, "Vibing")).toBe(true)
    expect(hasStatus("", "Vibing")).toBe(true)
  })

  it("true when both are set", () => {
    expect(hasStatus("🎧", "Vibing")).toBe(true)
  })
})

describe("matchingPreset", () => {
  it("finds the exact preset for a matching emoji+text pair", () => {
    expect(matchingPreset("🎧", "Vibing")).toEqual({ emoji: "🎧", text: "Vibing" })
  })

  it("returns undefined for a custom (non-preset) pair", () => {
    expect(matchingPreset("🍕", "Pizza time")).toBeUndefined()
  })

  it("returns undefined when the emoji is overridden away from its preset pairing", () => {
    // Same term as a preset, but a different emoji — not an exact preset match.
    expect(matchingPreset("🍕", "Vibing")).toBeUndefined()
  })

  it("every preset is internally self-consistent (round-trips through matchingPreset)", () => {
    for (const preset of STATUS_PRESETS) {
      expect(matchingPreset(preset.emoji, preset.text)).toEqual(preset)
    }
  })
})
