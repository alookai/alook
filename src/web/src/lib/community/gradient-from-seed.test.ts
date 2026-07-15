import { describe, it, expect } from "vitest"
import { BG_COLORS } from "@/components/avatar/avatar-parts"
import { gradientFromSeed, gradientColorsFromSeed, gradientAngleFromSeed } from "./gradient-from-seed"

const PRESET_VALUES = new Set(BG_COLORS.map((c) => c.value))

describe("gradientColorsFromSeed", () => {
  it("picks three colors from the agent avatar preset palette", () => {
    const colors = gradientColorsFromSeed("seed_abc")
    expect(colors).toHaveLength(3)
    for (const c of colors) expect(PRESET_VALUES.has(c)).toBe(true)
  })

  it("picks three distinct colors", () => {
    const colors = gradientColorsFromSeed("seed_xyz")
    expect(new Set(colors).size).toBe(3)
  })

  it("is deterministic for the same seed", () => {
    expect(gradientColorsFromSeed("seed_1")).toEqual(gradientColorsFromSeed("seed_1"))
  })

  it("varies across different seeds", () => {
    const a = gradientColorsFromSeed("seed_1")
    const b = gradientColorsFromSeed("seed_2")
    expect(a).not.toEqual(b)
  })
})

describe("gradientAngleFromSeed", () => {
  it("returns a degree value within [0, 360)", () => {
    for (const seed of ["seed_abc", "seed_xyz", "seed_1", "seed_2"]) {
      const angle = gradientAngleFromSeed(seed)
      expect(angle).toBeGreaterThanOrEqual(0)
      expect(angle).toBeLessThan(360)
      expect(Number.isInteger(angle)).toBe(true)
    }
  })

  it("is deterministic for the same seed", () => {
    expect(gradientAngleFromSeed("seed_1")).toBe(gradientAngleFromSeed("seed_1"))
  })

  it("varies across different seeds", () => {
    const angles = new Set(["seed_1", "seed_2", "seed_3", "seed_4"].map(gradientAngleFromSeed))
    expect(angles.size).toBeGreaterThan(1)
  })
})

describe("gradientFromSeed", () => {
  it("builds a linear-gradient CSS value from a seeded angle and three preset colors", () => {
    const css = gradientFromSeed("seed_abc")
    expect(css).toMatch(/^linear-gradient\(\d+deg, .+, .+, .+\)$/)
    const [c0, c1, c2] = gradientColorsFromSeed("seed_abc")
    const angle = gradientAngleFromSeed("seed_abc")
    expect(css).toBe(`linear-gradient(${angle}deg, ${c0}, ${c1}, ${c2})`)
  })

  it("is deterministic for the same seed", () => {
    expect(gradientFromSeed("seed_1")).toBe(gradientFromSeed("seed_1"))
  })
})
