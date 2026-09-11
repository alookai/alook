import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { UnresolvedMainSkeleton } from "./unresolved-main-skeleton"

describe("UnresolvedMainSkeleton", () => {
  it("keeps one muted pulse over an opaque app surface with inert edge fades", () => {
    const markup = renderToStaticMarkup(createElement(UnresolvedMainSkeleton))

    expect(markup.match(/data-slot="skeleton"/g)).toHaveLength(1)
    expect(markup).toContain('data-community-unresolved-main=""')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain("h-full w-full flex-1 overflow-hidden bg-(--app-bg)")
    expect(markup).toContain("absolute inset-0 rounded-none")
    expect(markup).toContain("animate-pulse")
    expect(markup).toContain("motion-reduce:animate-none")
    expect(markup.match(/data-slot="app-edge-fade"/g)).toHaveLength(1)
    expect(markup.match(/h-\(--app-edge-fade-size\)/g)).toHaveLength(2)
    expect(markup).toContain("from-(--app-bg) to-transparent")
    expect(markup).toContain("from-transparent to-(--app-bg)")
    expect(markup).toContain("pointer-events-none")
    expect(markup).not.toContain("safe-area")
    expect(markup).not.toMatch(/rounded-(?:sm|md|lg|xl|2xl|3xl|full)(?:\s|")/)
  })
})
