import { describe, it, expect } from "vitest"
import { BG_COLORS } from "@/components/avatar/avatar-parts"
import { serverGradient, serverGradientColors, serverGradientAngle } from "./server-gradient"

const PRESET_VALUES = new Set(BG_COLORS.map((c) => c.value))

describe("serverGradientColors", () => {
  it("picks three colors from the agent avatar preset palette", () => {
    const colors = serverGradientColors("server_abc")
    expect(colors).toHaveLength(3)
    for (const c of colors) expect(PRESET_VALUES.has(c)).toBe(true)
  })

  it("picks three distinct colors", () => {
    const colors = serverGradientColors("server_xyz")
    expect(new Set(colors).size).toBe(3)
  })

  it("is deterministic for the same seed", () => {
    expect(serverGradientColors("server_1")).toEqual(serverGradientColors("server_1"))
  })

  it("varies across different seeds", () => {
    const a = serverGradientColors("server_1")
    const b = serverGradientColors("server_2")
    expect(a).not.toEqual(b)
  })
})

describe("serverGradientAngle", () => {
  it("returns a degree value within [0, 360)", () => {
    for (const seed of ["server_abc", "server_xyz", "server_1", "server_2"]) {
      const angle = serverGradientAngle(seed)
      expect(angle).toBeGreaterThanOrEqual(0)
      expect(angle).toBeLessThan(360)
      expect(Number.isInteger(angle)).toBe(true)
    }
  })

  it("is deterministic for the same seed", () => {
    expect(serverGradientAngle("server_1")).toBe(serverGradientAngle("server_1"))
  })

  it("varies across different seeds", () => {
    const angles = new Set(["server_1", "server_2", "server_3", "server_4"].map(serverGradientAngle))
    expect(angles.size).toBeGreaterThan(1)
  })
})

describe("serverGradient", () => {
  it("builds a linear-gradient CSS value from a random angle and three preset colors", () => {
    const css = serverGradient("server_abc")
    expect(css).toMatch(/^linear-gradient\(\d+deg, .+, .+, .+\)$/)
    const [c0, c1, c2] = serverGradientColors("server_abc")
    const angle = serverGradientAngle("server_abc")
    expect(css).toBe(`linear-gradient(${angle}deg, ${c0}, ${c1}, ${c2})`)
  })

  it("is deterministic for the same seed", () => {
    expect(serverGradient("server_1")).toBe(serverGradient("server_1"))
  })
})
