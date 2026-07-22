import { describe, it, expect } from "vitest"
import { PALETTES, paletteFromSeed } from "./boring-palettes"

describe("paletteFromSeed", () => {
  it("is deterministic for the same seed", () => {
    expect(paletteFromSeed("usr_1")).toBe(paletteFromSeed("usr_1"))
  })

  it("returns a palette that is a member of PALETTES (reference equality)", () => {
    const p = paletteFromSeed("usr_42")
    expect(PALETTES).toContain(p)
  })

  it("spreads across more than one palette over many seeds", () => {
    const seen = new Set(
      Array.from({ length: 60 }, (_, i) => paletteFromSeed(`seed_${i}`)),
    )
    expect(seen.size).toBeGreaterThan(1)
  })

  it("first palette is the official boringavatars.com sample", () => {
    expect(PALETTES[0]).toEqual(["#00686c", "#32c2b9", "#edecb3", "#fad928", "#ff9915"])
  })
})
