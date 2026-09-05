import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Skeleton } from "./skeleton"

describe("Skeleton", () => {
  it("keeps pulse paint-only and disables it for reduced motion", () => {
    const html = renderToStaticMarkup(createElement(Skeleton))

    expect(html).toContain("animate-pulse")
    expect(html).toContain("motion-reduce:animate-none")
  })
})
