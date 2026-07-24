import { describe, it, expect } from "vitest"
import Avatar from "boring-avatars"
import { BoringAvatar } from "./boring-avatar"

// BoringAvatar returns a wrapper <span> (co-locating the caller's radius
// className with overflow-hidden so a square SVG gets cropped to the container
// shape) whose single child is the boring-avatars <Avatar>.
type SpanEl = {
  type: "span"
  props: { className: string; style: { width: number | string; height: number | string }; children: AvatarEl }
}
type AvatarEl = { type: typeof Avatar; props: { square: boolean; size: number | string; className: string; variant: string; preserveAspectRatio?: string } }

function inner(el: unknown): AvatarEl["props"] {
  return (el as SpanEl).props.children.props
}

describe("BoringAvatar", () => {
  it("defaults to a SQUARE svg so the container radius crops it", () => {
    const el = BoringAvatar({ seed: "s1" }) as unknown as SpanEl
    expect(el.type).toBe("span")
    expect(inner(el).square).toBe(true)
  })

  it("still honors an explicit square={false}", () => {
    const el = BoringAvatar({ seed: "s1", square: false }) as unknown as SpanEl
    expect(inner(el).square).toBe(false)
  })

  it("co-locates the caller's radius className with overflow-hidden on the wrapper", () => {
    const el = BoringAvatar({ seed: "s1", className: "rounded-full" }) as unknown as SpanEl
    expect(el.props.className).toContain("rounded-full")
    expect(el.props.className).toContain("overflow-hidden")
  })

  it("gives the wrapper an explicit box from size, and fills it with the inner avatar", () => {
    const el = BoringAvatar({ seed: "s1", size: 40 }) as unknown as SpanEl
    expect(el.props.style).toEqual({ width: 40, height: 40 })
    expect(inner(el).size).toBe("100%")
    expect(inner(el).className).toContain("size-full")
  })

  it("forwards variant and preserveAspectRatio to the inner avatar (marble background)", () => {
    const el = BoringAvatar({ seed: "s1", variant: "marble", size: "100%", preserveAspectRatio: "none" }) as unknown as SpanEl
    expect(inner(el).variant).toBe("marble")
    expect(inner(el).preserveAspectRatio).toBe("none")
    expect(el.props.style).toEqual({ width: "100%", height: "100%" })
  })
})
