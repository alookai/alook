import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { UnresolvedMainSkeleton } from "./unresolved-main-skeleton"

describe("UnresolvedMainSkeleton", () => {
  it("keeps neutral loading motion on an opaque app background", () => {
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
    expect(markup).toContain("h-full w-full flex-1 overflow-hidden")
    expect(markup).toContain("bg-(--app-bg)")
    expect(markup).not.toContain("bg-black/10")
    expect(markup).not.toContain("backdrop-blur")
    expect(markup).toContain('data-connecting-motion=""')
    expect(markup).not.toContain("animate-pulse")
    expect(markup).not.toContain('data-slot="app-edge-fade"')
    expect(markup).not.toContain("data-app-edge=")
    expect(markup).not.toContain("safe-area")
    expect(markup).not.toMatch(/rounded-(?:sm|md|lg|xl|2xl|3xl|full)(?:\s|")/)
  })
})
