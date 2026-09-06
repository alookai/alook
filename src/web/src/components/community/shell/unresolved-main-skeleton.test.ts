import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { UnresolvedMainSkeleton } from "./unresolved-main-skeleton"

describe("UnresolvedMainSkeleton", () => {
  it("fills the main area with one inert square Skeleton and respects reduced motion", () => {
    const markup = renderToStaticMarkup(createElement(UnresolvedMainSkeleton))

    expect(markup.match(/data-slot="skeleton"/g)).toHaveLength(1)
    expect(markup).toContain('data-community-unresolved-main=""')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain("h-full w-full flex-1 rounded-none")
    expect(markup).toContain("animate-pulse")
    expect(markup).toContain("motion-reduce:animate-none")
    expect(markup).not.toMatch(/rounded-(?:sm|md|lg|xl|2xl|3xl|full)(?:\s|")/)
    expect(markup).toMatch(/^<div[^>]*><\/div>$/)
  })
})
