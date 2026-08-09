import { describe, expect, it } from "vitest"
import { SeededBackdrop } from "./seeded-backdrop"

describe("SeededBackdrop", () => {
  it("fills its positioned parent with the requested native SVG variant", () => {
    const profile = SeededBackdrop({ seed: "profile" }) as unknown as {
      props: { "aria-hidden": boolean; className: string; dangerouslySetInnerHTML: { __html: string } }
    }
    expect(profile.props["aria-hidden"]).toBe(true)
    expect(profile.props.className).toContain("absolute inset-0")
    expect(profile.props.dangerouslySetInnerHTML.__html).toContain('viewBox="0 0 80 80"')
    expect(profile.props.dangerouslySetInnerHTML.__html).toContain('preserveAspectRatio="none"')
  })
})
