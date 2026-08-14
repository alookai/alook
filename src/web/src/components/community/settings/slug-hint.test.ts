import { describe, it, expect } from "vitest"
import { SlugHint } from "./slug-hint"

type PEl<C> = { props: { children: C } }

describe("SlugHint", () => {
  it("renders nothing when neither invalid nor changed", () => {
    expect(SlugHint({ slug: "general", invalid: false, changed: false })).toBeNull()
  })

  it("renders the invalid message when invalid", () => {
    const el = SlugHint({ slug: "", invalid: true, changed: false }) as PEl<string>
    expect(el.props.children).toContain("space, / or #")
  })

  it("renders 'Will be saved as <slug>' when changed", () => {
    const el = SlugHint({ slug: "My-Home", invalid: false, changed: true }) as PEl<
      [string, PEl<string>]
    >
    expect(el.props.children[0]).toBe("Will be saved as ")
    expect(el.props.children[1].props.children).toBe("My-Home")
  })

  it("invalid takes precedence over changed when both are set", () => {
    const el = SlugHint({ slug: "x", invalid: true, changed: true }) as PEl<string>
    expect(el.props.children).toContain("space, / or #")
  })
})
