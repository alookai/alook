import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ChannelHeaderSkeleton } from "./channel-header"

describe("ChannelHeaderSkeleton", () => {
  it("renders Back geometry without exposing loading interaction", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelHeaderSkeleton, { onBack: vi.fn() }),
    )

    expect(html).toContain('data-slot="loading-back-placeholder"')
    expect(html).not.toContain("<button")
    expect(html).not.toContain('aria-label="Back"')
  })
})
