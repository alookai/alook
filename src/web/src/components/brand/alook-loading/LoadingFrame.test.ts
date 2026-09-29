import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LoadingFrame } from "./LoadingFrame"
import { DURATION } from "./motion"

describe("LoadingFrame loop boundary", () => {
  it("renders the same completed geometry, transforms, and opacity at both ends", () => {
    const first = renderToStaticMarkup(createElement(LoadingFrame, { frame: 0 }))
    const final = renderToStaticMarkup(createElement(LoadingFrame, { frame: DURATION - 1 }))

    expect(final).toBe(first)
    expect(first).toContain("clip-path:inset(0px round 152.109375px)")
    expect(first.match(/translate:0px 0px/g)).toHaveLength(5)
    expect(first.match(/scale:1/g)).toHaveLength(5)
    expect(first.match(/opacity=\"0\"/g)).toHaveLength(4)
  })
})
