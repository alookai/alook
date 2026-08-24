import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { DmHeaderSkeleton } from "./dm-header"

describe("DmHeaderSkeleton", () => {
  it("reserves avatar, title, notification, and optional Back footprints", () => {
    const desktop = renderToStaticMarkup(createElement(DmHeaderSkeleton))
    expect(desktop).toContain("size-6 rounded-full")
    expect(desktop).toContain("h-4 w-32 rounded")
    expect(desktop).toContain("ml-auto size-7 rounded-md")
    expect(desktop).not.toContain('aria-label="Back"')

    const mobile = renderToStaticMarkup(
      createElement(DmHeaderSkeleton, { onBack: vi.fn() }),
    )
    expect(mobile).toContain('data-slot="loading-back-placeholder"')
    expect(mobile).not.toContain("<button")
    expect(mobile).not.toContain('aria-label="Back"')
  })
})
