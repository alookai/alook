import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { tid } from "@/lib/community/testids"
import { ChannelHeaderSkeleton } from "./channel-header"

describe("ChannelHeaderSkeleton", () => {
  it("renders inert mobile Back geometry without interaction", () => {
    const html = renderToStaticMarkup(createElement(ChannelHeaderSkeleton))

    expect(html).toContain(`data-testid="${tid.messageHeaderLeadingLoading}"`)
    expect(html).toContain('data-slot="loading-mobile-leading"')
    expect(html).toContain('data-slot="message-header-identity"')
    expect(html).toContain('data-slot="message-header-actions"')
    expect(html).toMatch(/class="[^"]*size-11[^"]*sm:hidden[^"]*"/)
    expect(html).toMatch(/class="[^"]*size-6[^"]*rounded-md[^"]*"/)
    expect(html).toMatch(/class="[^"]*ml-1 size-7 rounded-md"/)
    expect(html).not.toContain("<button")
    expect(html).not.toContain('aria-label="Back"')
  })
})
