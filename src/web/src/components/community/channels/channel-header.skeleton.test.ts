import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { tid } from "@/lib/community/testids"
import { ChannelHeaderSkeleton } from "./channel-header"

describe("ChannelHeaderSkeleton", () => {
  it("renders inert mobile server-leading geometry without Back interaction", () => {
    const html = renderToStaticMarkup(createElement(ChannelHeaderSkeleton))

    expect(html).toContain(`data-testid="${tid.channelHeaderServerLoading}"`)
    expect(html).toContain('data-slot="loading-server-leading"')
    expect(html).toMatch(/class="[^"]*size-11[^"]*sm:hidden[^"]*"/)
    expect(html).toMatch(/class="[^"]*size-6[^"]*rounded-md[^"]*"/)
    expect(html).not.toContain("<button")
    expect(html).not.toContain('aria-label="Back"')
    expect(html).not.toContain("loading-back-placeholder")
  })
})
