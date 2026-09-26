import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { UnresolvedMainSkeleton } from "./unresolved-main-skeleton"

describe("UnresolvedMainSkeleton", () => {
  it("shows only the neutral loading motion on a static app surface with inert edge fades", () => {
    const markup = renderToStaticMarkup(createElement(UnresolvedMainSkeleton))

    expect(markup).not.toContain('data-slot="skeleton"')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-label="Loading"')
    expect(markup).not.toContain("Connecting")
    expect(markup).not.toContain('role="dialog"')
    expect(markup).not.toContain('aria-modal')
    expect(markup).not.toContain('community-ws-reconnect-title')
    expect(markup).toContain('data-community-unresolved-main=""')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain("h-full w-full flex-1 overflow-hidden bg-(--app-bg)")
    expect(markup).not.toContain("animate-pulse")
    expect(markup.match(/data-slot="app-edge-fade"/g)).toHaveLength(1)
    expect(markup.match(/h-\(--app-edge-fade-size\)/g)).toHaveLength(2)
    expect(markup).toContain("from-(--app-bg) to-transparent")
    expect(markup).toContain("from-transparent to-(--app-bg)")
    expect(markup).toContain("pointer-events-none")
    expect(markup).not.toContain("safe-area")
    expect(markup).not.toMatch(/rounded-(?:sm|md|lg|xl|2xl|3xl|full)(?:\s|")/)
  })
})
