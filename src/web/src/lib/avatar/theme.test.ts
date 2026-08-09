import { describe, expect, it } from "vitest"
import { AVATAR_PALETTES, avatarThemeFromSeed } from "./theme"

describe("avatarThemeFromSeed", () => {
  it("preserves the approved palette selection and face color roles", () => {
    expect(avatarThemeFromSeed("usr_42")).toEqual({
      palette: AVATAR_PALETTES[10],
      face: "#c6e5d9",
      background: "#e94e77",
      ink: "#000000",
      accents: ["#d68189", "#c6a49a", "#f4ead5"],
      darkest: "#e94e77",
    })
  })

  it("is deterministic and returns the selected palette by reference", () => {
    const first = avatarThemeFromSeed("stable-id")
    const second = avatarThemeFromSeed("stable-id")
    expect(first).toEqual(second)
    expect(AVATAR_PALETTES).toContain(first.palette)
  })

  it("ships all 25 approved five-color worlds", () => {
    expect(AVATAR_PALETTES).toHaveLength(25)
    for (const palette of AVATAR_PALETTES) expect(palette).toHaveLength(5)
  })

  it("spreads seeds across multiple themes", () => {
    const palettes = new Set(Array.from({ length: 60 }, (_, index) =>
      avatarThemeFromSeed(`seed_${index}`).palette,
    ))
    expect(palettes.size).toBeGreaterThan(1)
  })
})
