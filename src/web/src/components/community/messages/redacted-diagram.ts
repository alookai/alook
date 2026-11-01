import type { DiagramPlugin } from "streamdown"

const SVG = "http://www.w3.org/2000/svg"
const HTML = "http://www.w3.org/1999/xhtml"
const TOKEN = /\[REDACTED(?:_[A-Z0-9]+)*\]/g

export function redactDiagramSvg(svg: string): string {
  if (!svg.includes("[REDACTED")) return svg
  const theme = getComputedStyle(document.documentElement)
  const background = theme.getPropertyValue("--muted").trim()
  const foreground = theme.getPropertyValue("--muted-foreground").trim()
  const font = getComputedStyle(document.body).fontFamily
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  const measured: SVGTSpanElement[] = []
  for (const node of nodes) {
    const parent = node.parentElement
    if (!parent || parent.closest("style, script, title, desc")) continue
    const html = !!parent.closest("foreignObject")
    if (!html && !parent.closest("text")) continue
    const parts = node.data.split(new RegExp(`(${TOKEN.source})`, "g"))
    if (parts.length === 1) continue
    node.replaceWith(...parts.map((value, index) => {
      if (!(index % 2)) return document.createTextNode(value)
      const badge = document.createElementNS(html ? HTML : SVG, html ? "span" : "tspan")
      badge.setAttribute("data-redacted", "")
      badge.setAttribute("aria-label", "redacted")
      badge.textContent = "redacted"
      badge.setAttribute("style", `font-size:12px;font-family:${font};font-weight:500;color:${foreground};fill:${foreground}`)
      if (html) {
        badge.setAttribute("style", `${badge.getAttribute("style")};display:inline-block;white-space:nowrap;background:${background};border-radius:3px;padding:0 4px;line-height:1.5`)
      } else measured.push(badge as SVGTSpanElement)
      return badge
    }))
  }
  const host = document.createElement("div")
  host.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none"
  try {
    if (measured.length) {
      host.appendChild(root)
      document.body.appendChild(host)
      for (const badge of measured) {
        const text = badge.closest("text")!
        const box = badge.getBBox()
        const rect = document.createElementNS(SVG, "rect")
        rect.setAttribute("x", String(box.x - 3))
        rect.setAttribute("y", String(box.y - 1))
        rect.setAttribute("width", String(box.width + 6))
        rect.setAttribute("height", String(box.height + 2))
        rect.setAttribute("rx", "3")
        rect.setAttribute("style", `fill:${background};stroke:none`)
        if (text.hasAttribute("transform")) rect.setAttribute("transform", text.getAttribute("transform")!)
        text.parentNode!.insertBefore(rect, text)
      }
    }
    return new XMLSerializer().serializeToString(root)
  } finally {
    host.remove()
  }
}

export function withRedactedDiagrams(plugin: DiagramPlugin): DiagramPlugin {
  return {
    ...plugin,
    getMermaid(config) {
      const engine = plugin.getMermaid(config)
      return {
        initialize: (next) => engine.initialize(next),
        async render(id, source) {
          const result = await engine.render(id, source)
          return { ...result, svg: redactDiagramSvg(result.svg) }
        },
      }
    },
  }
}
