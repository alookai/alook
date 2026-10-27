import { describe, expect, it, vi } from "vitest"
import { redactDiagramSvg, withRedactedDiagrams } from "./redacted-diagram"

describe("redacted diagrams", () => {
  it("preserves source passed to Mermaid and adds badges only to rendered labels", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>.x{content:"[REDACTED_TOKEN]"}</style><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Email [REDACTED_EMAIL]</div></foreignObject></svg>'
    const engine = { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg }) }
    const plugin = withRedactedDiagrams({ name: "mermaid", type: "diagram", language: "mermaid", getMermaid: () => engine })
    const source = 'graph LR; A["Email [REDACTED_EMAIL]"]-->B'
    const result = await plugin.getMermaid().render("diagram1", source)
    expect(engine.render).toHaveBeenCalledWith("diagram1", source)
    const doc = new DOMParser().parseFromString(result.svg, "image/svg+xml")
    expect(doc.querySelector("parsererror")).toBeNull()
    expect(result.svg).not.toContain("var(--")
    expect(doc.querySelector("foreignObject [data-redacted]")?.textContent).toBe("redacted")
    expect(doc.querySelector("style")?.textContent).toContain("[REDACTED_TOKEN]")
  })

  it("positions SVG-only badge backgrounds in the label coordinate system and cleans measurement DOM", () => {
    const previous = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox")
    Object.defineProperty(SVGElement.prototype, "getBBox", { configurable: true, value: () => ({ x: 10, y: 20, width: 50, height: 12 }) })
    const before = document.body.childElementCount
    try {
      const result = redactDiagramSvg('<svg xmlns="http://www.w3.org/2000/svg"><g><text transform="translate(4 5)"><tspan>[REDACTED_EMAIL]</tspan></text></g></svg>')
      const doc = new DOMParser().parseFromString(result, "image/svg+xml")
      expect(doc.querySelector("rect")?.getAttribute("transform")).toBe("translate(4 5)")
      expect(doc.querySelector("rect")?.getAttribute("width")).toBe("56")
      expect(doc.querySelector("text [data-redacted]")?.textContent).toBe("redacted")
      expect(document.body.childElementCount).toBe(before)
    } finally {
      if (previous) Object.defineProperty(SVGElement.prototype, "getBBox", previous)
      else Reflect.deleteProperty(SVGElement.prototype, "getBBox")
    }
  })

  it("returns diagrams without markers unchanged", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Ordinary diagram</text></svg>'
    expect(redactDiagramSvg(svg)).toBe(svg)
  })
})
