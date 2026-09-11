import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { AppEdgeFade } from "./app-edge-fade"

describe("AppEdgeFade", () => {
  it("paints only fixed top and bottom app-background fades without interaction", () => {
    const markup = renderToStaticMarkup(createElement(AppEdgeFade))

    expect(markup).toContain('data-slot="app-edge-fade"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain("pointer-events-none")
    expect(markup.match(/h-\(--app-edge-fade-size\)/g)).toHaveLength(2)
    expect(markup).toContain("top-0")
    expect(markup).toContain("from-(--app-bg) to-transparent")
    expect(markup).toContain("bottom-0")
    expect(markup).toContain("from-transparent to-(--app-bg)")
    expect(markup).not.toContain("safe-area")
    expect(markup).not.toContain("animate")
    expect(markup).not.toMatch(/tabindex|button|href=/)
  })

  it("defines one fixed 60px token independent of the app safe-area tokens", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../../app/globals.css", import.meta.url)),
      "utf8",
    )
    const token = css.match(/--app-edge-fade-size:\s*([^;]+);/)

    expect(token?.[1]?.trim()).toBe("60px")
    expect(token?.[1]).not.toContain("safe-area")
    expect(css.match(/--app-edge-fade-size:/g)).toHaveLength(1)
  })
})
