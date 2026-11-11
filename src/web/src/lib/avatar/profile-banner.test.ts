import { describe, expect, it } from "vitest"
import { PROFILE_BANNER_PATTERNS, profileBannerBackground, profileBannerPattern } from "./profile-banner"

const SEEDS = Array.from({ length: 60 }, (_, index) => `user-${index}`)

describe("profileBannerBackground", () => {
  it("is stable for the same seed", () => {
    for (const seed of SEEDS) expect(profileBannerBackground(seed)).toBe(profileBannerBackground(seed))
  })

  it("spreads people across every comic pattern", () => {
    const counts = new Map(PROFILE_BANNER_PATTERNS.map((pattern) => [pattern, 0]))
    for (const seed of SEEDS) counts.set(profileBannerPattern(seed), counts.get(profileBannerPattern(seed))! + 1)
    for (const count of counts.values()) expect(count).toBeGreaterThan(8)
  })

  it("gives nearly every person a distinct banner", () => {
    expect(new Set(SEEDS.map(profileBannerBackground)).size).toBe(SEEDS.length)
  })

  it("uses ink outlines and a dot screen in every pattern", () => {
    for (const seed of SEEDS) {
      const background = profileBannerBackground(seed)
      expect(background).toContain("#1f1a15")
      expect(background).toMatch(/radial-gradient\(circle/)
    }
  })
})
