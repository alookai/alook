import { describe, expect, it } from "vitest"
import { LANDING_TESTIMONIALS, rankTestimonials } from "./landing-testimonials-data"

describe("published landing testimonial inventory", () => {
  it("contains at least 20 distinct source posts with attributable short quotations", () => {
    expect(LANDING_TESTIMONIALS.length).toBeGreaterThanOrEqual(20)
    expect(new Set(LANDING_TESTIMONIALS.map(({ url }) => url)).size).toBe(LANDING_TESTIMONIALS.length)
    expect(new Set(LANDING_TESTIMONIALS.map(({ id }) => id)).size).toBe(LANDING_TESTIMONIALS.length)
    for (const post of LANDING_TESTIMONIALS) {
      const source = new URL(post.url)
      expect(source.protocol).toBe("https:")
      expect(source.username + source.password).toBe("")
      expect(post.name.trim()).not.toBe("")
      expect(post.handle.trim()).not.toBe("")
      expect(post.quote.trim()).not.toBe("")
      expect(Number.isNaN(Date.parse(post.checkedAt))).toBe(false)
      expect(post.followers === null || (Number.isInteger(post.followers) && post.followers >= 0)).toBe(true)
      expect(post.quote.trim().split(/\s+/).length).toBeLessThanOrEqual(25)
    }
  })

  it("orders the complete published collection by known author audience, unknown last", () => {
    const ranked = rankTestimonials(LANDING_TESTIMONIALS)
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].followers ?? -1).toBeGreaterThanOrEqual(ranked[i].followers ?? -1)
    }
  })
})
