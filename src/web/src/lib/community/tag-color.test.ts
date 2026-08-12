import { describe, expect, it } from "vitest"
import { tagColorClassName, tagColorStyle, tagHue } from "./tag-color"

describe("forum tag color", () => {
  it("is deterministic and confined to the curated hue palette", () => {
    const palette = [8, 30, 55, 95, 145, 175, 205, 250, 290, 330]
    expect(tagHue("design")).toBe(tagHue("design"))
    for (const tag of ["design", "bug", "help", "ideas", "urgent"]) {
      expect(palette).toContain(tagHue(tag))
    }
  })

  it("keeps theme values in CSS and exposes only the selected hue inline", () => {
    expect(tagColorStyle("design")).toEqual({ "--forum-tag-hue": tagHue("design") })
    expect(tagColorClassName).toBe("forum-tag-color")
  })

  it("does not collapse representative tags onto one hue", () => {
    const hues = new Set(["design", "bug", "help", "ideas", "urgent"].map(tagHue))
    expect(hues.size).toBeGreaterThan(2)
  })
})
