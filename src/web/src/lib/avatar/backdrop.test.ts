import { describe, expect, it } from "vitest"
import { renderSeededBackdropSvg, seededStripeAngle } from "./backdrop"

describe("renderSeededBackdropSvg", () => {
  it.each([
    {
      seed: "Alice",
      colors: ["#ffab62", "#ffe0a6", "#432526"],
      first: "translate(0 0) rotate(176 40 40) scale(1.2)",
      second: "translate(0 0) rotate(-264 40 40) scale(1.2)",
    },
    {
      seed: "server-id",
      colors: ["#25294f", "#4d5c9a", "#7587d6"],
      first: "translate(6 6) rotate(70 40 40) scale(1.3)",
      second: "translate(-1 1) rotate(-105 40 40) scale(1.3)",
    },
    {
      seed: "avatar:stable-seed",
      colors: ["#8a5a9e", "#e0729a", "#ffb26b"],
      first: "translate(4 -4) rotate(172 40 40) scale(1.4)",
      second: "translate(2 -2) rotate(258 40 40) scale(1.4)",
    },
  ])("matches boring-avatars 2.0.4 marble fixtures for $seed", ({ seed, colors, first, second }) => {
    const svg = renderSeededBackdropSvg(seed)
    expect(svg).toContain(`<rect width="80" height="80" fill="${colors[0]}"/>`)
    expect(svg).toContain(`fill="${colors[1]}" transform="${first}"`)
    expect(svg).toContain(`fill="${colors[2]}" transform="${second}"`)
  })

  it("keeps the upstream 80px marble composition and stretching behavior", () => {
    const svg = renderSeededBackdropSvg("profile-id")
    expect(svg).toContain('viewBox="0 0 80 80"')
    expect(svg).toContain('preserveAspectRatio="none"')
    expect(svg.match(/<path /g)).toHaveLength(2)
    expect(svg.match(/filter="url\(#/g)).toHaveLength(2)
    expect(svg).toContain('style="mix-blend-mode:overlay"')
    expect(svg).toContain('<feGaussianBlur stdDeviation="7"')
    expect(svg).not.toContain("fill-opacity")
  })

  it("is deterministic regardless of where the backdrop is placed", () => {
    const svg = renderSeededBackdropSvg("stable-id")
    expect(renderSeededBackdropSvg("stable-id")).toBe(svg)
  })

  it("varies the upstream color and transform data across seeds", () => {
    const normalizeIds = (svg: string) => svg.replace(/alook-marble-\d+/g, "id")
    expect(normalizeIds(renderSeededBackdropSvg("server-a"))).not.toBe(
      normalizeIds(renderSeededBackdropSvg("server-b")),
    )
  })
})

describe("seededStripeAngle", () => {
  const seeds = ["Alice", "Milo", "Nova", "Zoë", "🌻", ...Array.from({ length: 100 }, (_, i) => `person-${i}`)]

  it("keeps diverse seeds stable and within the signed 22.5–45 degree range", () => {
    for (const seed of seeds) {
      const angle = seededStripeAngle(seed)
      expect(seededStripeAngle(seed)).toBe(angle)
      expect(Math.abs(angle)).toBeGreaterThanOrEqual(22.5)
      expect(Math.abs(angle)).toBeLessThanOrEqual(45)
    }
  })

  it("varies both the direction and tilt across people", () => {
    const angles = seeds.map(seededStripeAngle)
    expect(angles.some(angle => angle < 0)).toBe(true)
    expect(angles.some(angle => angle > 0)).toBe(true)
    expect(new Set(angles.map(Math.abs)).size).toBeGreaterThan(1)
  })
})
