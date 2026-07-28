import { describe, it, expect } from "vitest"
import Avatar from "boring-avatars"
import { BoringAvatar } from "./boring-avatar"

// BoringAvatar returns a wrapper <span> (co-locating the caller's radius
// className with overflow-hidden so a square SVG gets cropped to the container
// shape). Its child depends on variant:
//   - beam (default): our own face renderer, injected as SVG via a span.
//   - marble: the boring-avatars <Avatar> (gradient background).
type SpanEl = {
  type: "span"
  props: {
    className: string
    style: { width: number | string; height: number | string }
    children: unknown
  }
}
type AvatarEl = { type: typeof Avatar; props: { square: boolean; size: number | string; className: string; variant: string; preserveAspectRatio?: string } }

function child(el: unknown): unknown {
  return (el as SpanEl).props.children
}

describe("BoringAvatar", () => {
  it("renders our generated face SVG for the default (beam) variant", () => {
    const el = BoringAvatar({ seed: "s1" }) as unknown as SpanEl
    expect(el.type).toBe("span")
    const inner = child(el) as { props: { dangerouslySetInnerHTML: { __html: string } } }
    // beam is our face renderer, not the lib — injected as an SVG string.
    expect(inner.props.dangerouslySetInnerHTML.__html).toContain("<svg")
    expect(inner.props.dangerouslySetInnerHTML.__html).toContain('viewBox="0 0 36 36"')
  })

  it("is deterministic — same seed renders the same beam face", () => {
    const a = BoringAvatar({ seed: "s1" }) as unknown as SpanEl
    const b = BoringAvatar({ seed: "s1" }) as unknown as SpanEl
    const ha = (child(a) as { props: { dangerouslySetInnerHTML: { __html: string } } }).props.dangerouslySetInnerHTML.__html
    const hb = (child(b) as { props: { dangerouslySetInnerHTML: { __html: string } } }).props.dangerouslySetInnerHTML.__html
    expect(ha).toBe(hb)
  })

  it("co-locates the caller's radius className with overflow-hidden on the wrapper", () => {
    const el = BoringAvatar({ seed: "s1", className: "rounded-full" }) as unknown as SpanEl
    expect(el.props.className).toContain("rounded-full")
    expect(el.props.className).toContain("overflow-hidden")
  })

  it("gives the wrapper an explicit box from size", () => {
    const el = BoringAvatar({ seed: "s1", size: 40 }) as unknown as SpanEl
    expect(el.props.style).toEqual({ width: 40, height: 40 })
  })

  it("forwards variant/square/preserveAspectRatio to the lib for marble (background)", () => {
    const el = BoringAvatar({ seed: "s1", variant: "marble", size: "100%", preserveAspectRatio: "none", square: false }) as unknown as SpanEl
    const inner = child(el) as AvatarEl
    expect(inner.type).toBe(Avatar)
    expect(inner.props.variant).toBe("marble")
    expect(inner.props.preserveAspectRatio).toBe("none")
    expect(inner.props.square).toBe(false)
    expect(inner.props.size).toBe("100%")
    expect(el.props.style).toEqual({ width: "100%", height: "100%" })
  })
})
