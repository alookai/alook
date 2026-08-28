import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { RailIndicator } from "./rail-indicator"

function markup(props: Parameters<typeof RailIndicator>[0]) {
  return renderToStaticMarkup(createElement(RailIndicator, props))
}

describe("RailIndicator", () => {
  it.each([
    [{ active: true, unread: true }, "h-10"],
    [{ active: false, unread: true }, "h-2.5"],
    [{ active: false, unread: false }, "h-0"],
  ] as const)("resolves resting height precedence for %o", (props, height) => {
    const html = markup(props)
    expect(html).toContain(height)
    expect(html).toContain("w-1")
    expect(html).toContain("bg-foreground")
    expect(html).toContain("rounded-r-full")
    expect(html).toContain("duration-150")
    if (!props.active) {
      expect(html).toContain("group-hover:h-5")
      expect(html).toContain("group-focus-within:h-5")
    } else {
      expect(html).not.toContain("group-hover:h-5")
    }
  })

  it("exposes the canonical geometry locator", () => {
    expect(markup({ testId: "indicator-id" })).toContain('data-testid="indicator-id"')
  })
})
