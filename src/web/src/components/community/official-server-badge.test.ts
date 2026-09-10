import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { OfficialServerBadge } from "./official-server-badge"

describe("OfficialServerBadge", () => {
  it.each([false, undefined])("does not render for unofficial or older cached servers (%s)", (official) => {
    expect(renderToStaticMarkup(createElement(OfficialServerBadge, { official }))).toBe("")
  })

  it("renders the shared flat asset with accessible identity and fixed size", () => {
    const html = renderToStaticMarkup(createElement(OfficialServerBadge, { official: true, className: "absolute" }))
    expect(html).toContain('alt="Official server"')
    expect(html).toContain('src="/official-server-badge-flat.svg"')
    expect(html).toContain('width="20"')
    expect(html).toContain('height="20"')
    expect(html).toContain('draggable="false"')
    expect(html).toContain("absolute")
  })
})
