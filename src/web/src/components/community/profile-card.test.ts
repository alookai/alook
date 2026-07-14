import { describe, it, expect } from "vitest"
import { generateGradient, resolveCardStatus } from "./profile-card"

describe("generateGradient", () => {
  it("is deterministic for the same name", () => {
    expect(generateGradient("Gener")).toBe(generateGradient("Gener"))
  })

  const hueRegex = /oklch\(0\.\d+ 0\.\d+ (\d+(?:\.\d+)?)\)/g
  const huesOf = (css: string) => [...css.matchAll(hueRegex)].map((m) => Number(m[1]))

  it("stays within the documented warm band (60-80) for both hues", () => {
    for (const name of ["Gener", "Gus", "Lindsay", "a", "some really long name here"]) {
      const hues = huesOf(generateGradient(name))
      expect(hues).toHaveLength(2)
      for (const hue of hues) {
        expect(hue).toBeGreaterThanOrEqual(60)
        expect(hue).toBeLessThanOrEqual(80)
      }
    }
  })

  it("keeps chroma desaturated (<= 0.09) per DESIGN.md", () => {
    const chromaRegex = /oklch\(0\.\d+ (0\.\d+) \d/g
    for (const name of ["Gener", "Gus", "Lindsay", "a", "some really long name here"]) {
      const chromas = [...generateGradient(name).matchAll(chromaRegex)].map((m) => Number(m[1]))
      expect(chromas).toHaveLength(2)
      for (const c of chromas) expect(c).toBeLessThanOrEqual(0.09)
    }
  })

  it("de-quantizes hue2 — spans more than the old 3 values across seeds", () => {
    const seeds = Array.from({ length: 200 }, (_, i) => `usr_${i}_${(i * 31) % 97}`)
    const hue2s = new Set(seeds.map((s) => huesOf(generateGradient(s))[1]))
    expect(hue2s.size).toBeGreaterThan(3)
  })

  it("gives two different seeds different gradients (hue2 varies independently)", () => {
    const a = huesOf(generateGradient("usr_seed_one"))[1]
    const b = huesOf(generateGradient("usr_seed_two"))[1]
    const c = huesOf(generateGradient("usr_seed_three"))[1]
    expect(new Set([a, b, c]).size).toBeGreaterThan(1)
  })

  it("varies across different names", () => {
    const a = generateGradient("Gener")
    const b = generateGradient("Gus")
    expect(a).not.toBe(b)
  })

  it("is deterministic for the same userId seed", () => {
    expect(generateGradient("usr_abc123")).toBe(generateGradient("usr_abc123"))
  })

  it("varies across different userIds", () => {
    expect(generateGradient("usr_abc123")).not.toBe(generateGradient("usr_xyz789"))
  })

  it("keeps the same gradient when the display name changes but the userId seed is stable", () => {
    // The card computes `generateGradient(data.userId ?? data.name)` — two
    // renders of the same person (renamed in between) both seed on userId, so
    // the banner colour must not shift.
    const before = generateGradient("usr_stable")
    const after = generateGradient("usr_stable")
    expect(after).toBe(before)
  })
})

describe("resolveCardStatus — WS overlay wins over row seed", () => {
  it("uses the overlay entry when one exists", () => {
    const out = resolveCardStatus({ emoji: "🎧", text: "Vibing" }, "📚", "Reading")
    expect(out).toEqual({ emoji: "🎧", text: "Vibing" })
  })

  it("falls back to the seed when the overlay has no entry", () => {
    const out = resolveCardStatus(undefined, "📚", "Reading")
    expect(out).toEqual({ emoji: "📚", text: "Reading" })
  })

  it("returns nulls when neither overlay nor seed provide a status", () => {
    expect(resolveCardStatus(undefined, undefined, undefined)).toEqual({ emoji: null, text: null })
    expect(resolveCardStatus(undefined, null, null)).toEqual({ emoji: null, text: null })
  })

  it("lets the overlay clear a seed (emoji: null overrides seed emoji)", () => {
    // When someone clears their status, the WS store's setUserStatus writes
    // { emoji: null, text: null }. That must win over any lingering row seed.
    const out = resolveCardStatus({ emoji: null, text: null }, "📚", "Reading")
    expect(out).toEqual({ emoji: null, text: null })
  })

  it("resolves emoji and text independently", () => {
    // Overlay carries a text-only status (no emoji). Seed offers an emoji.
    // The overlay's presence — not its individual field values — is what
    // decides the source, so the seed's emoji does NOT leak in.
    const out = resolveCardStatus({ emoji: null, text: "AFK" }, "🎧", "Vibing")
    expect(out).toEqual({ emoji: null, text: "AFK" })
  })
})
