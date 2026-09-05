import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ServerIcon } from "./server-icon"

describe("ServerIcon seeded fallback", () => {
  it.each([16, 20, 40, 64])("keeps a white initial over the native icon backdrop at %ipx", (size) => {
    const html = renderToStaticMarkup(createElement(ServerIcon, {
      id: "server-id",
      name: "Alook",
      initial: "A",
      size,
    }))
    expect(html).toContain(`width:${size}px;height:${size}px`)
    expect(html).toContain('viewBox="0 0 80 80"')
    expect(html).toContain("text-white")
    expect(html).toContain(">A</span>")
  })

  it("keeps the seeded SVG stable across server renames", () => {
    const render = (name: string) => renderToStaticMarkup(createElement(ServerIcon, {
      id: "server-id",
      name,
      initial: name[0],
      size: 40,
    }))
    const svg = (html: string) => html.match(/<svg[\s\S]*<\/svg>/)?.[0]
    expect(svg(render("Alook"))).toBe(svg(render("Renamed")))
  })

  it("leaves uploaded icons untouched", () => {
    const html = renderToStaticMarkup(createElement(ServerIcon, {
      id: "server-id",
      name: "Alook",
      initial: "A",
      icon: "/icon.png",
    }))
    expect(html).toContain('role="img" aria-label="Alook"')
    expect(html).toContain('data-remote-image-kind="identity"')
    expect(html).toContain('src="/icon.png" alt=""')
    expect(html).not.toContain("<svg")
  })
})
