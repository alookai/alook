import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AnimatedAlookLogo } from "./animated-alook-logo"

describe("AnimatedAlookLogo", () => {
  it("preserves the five-face mark and exposes one reversible hover state", () => {
    const html = renderToStaticMarkup(createElement(AnimatedAlookLogo, { className: "size-10" }))

    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Alook"')
    expect(html).toContain('rx="236"')
    expect(html.match(/data-face=/g)).toHaveLength(5)
    expect(html).toContain('data-motion="orange-glance"')
    expect(html).toContain("group-hover/alook")
    expect(html).toContain("motion-reduce:group-hover/alook:translate-none")
    expect(html).toContain("motion-reduce:group-hover/alook:scale-none")
    expect(html).toContain("motion-reduce:transition-none")
    expect(html).toContain("duration-[180ms]")
    expect(html).toContain("group-hover/alook:duration-[240ms]")
  })
})
