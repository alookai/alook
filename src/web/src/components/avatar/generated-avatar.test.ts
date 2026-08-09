import { describe, expect, it } from "vitest"
import { GeneratedAvatar } from "./generated-avatar"

type SpanElement = {
  type: "span"
  props: {
    className: string
    style: { width: number | string; height: number | string }
    children: unknown
  }
}

function child(element: unknown): unknown {
  return (element as SpanElement).props.children
}

describe("GeneratedAvatar", () => {
  it("renders the deterministic 36-unit generated face", () => {
    const element = GeneratedAvatar({ seed: "s1" }) as unknown as SpanElement
    const inner = child(element) as { props: { dangerouslySetInnerHTML: { __html: string } } }
    expect(element.type).toBe("span")
    expect(inner.props.dangerouslySetInnerHTML.__html).toContain('viewBox="0 0 36 36"')
    expect(GeneratedAvatar({ seed: "s1" })).toEqual(GeneratedAvatar({ seed: "s1" }))
  })

  it("keeps radius and overflow clipping on the same Safari-safe wrapper", () => {
    const element = GeneratedAvatar({ seed: "s1", className: "rounded-full" }) as unknown as SpanElement
    expect(element.props.className).toContain("rounded-full")
    expect(element.props.className).toContain("overflow-hidden")
  })

  it("preserves numeric and string size contracts", () => {
    expect((GeneratedAvatar({ seed: "s1", size: 40 }) as unknown as SpanElement).props.style).toEqual({ width: 40, height: 40 })
    expect((GeneratedAvatar({ seed: "s1", size: "100%" }) as unknown as SpanElement).props.style).toEqual({ width: "100%", height: "100%" })
  })
})
