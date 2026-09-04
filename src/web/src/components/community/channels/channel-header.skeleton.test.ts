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

  it.each([
    [{}, 6],
    [{ kind: "forum" as const }, 5],
    [{ kind: "thread" as const, compactActions: true }, 5],
  ])("reserves the authoritative action footprint for %o", (props, skeletonCount) => {
    const html = renderToStaticMarkup(createElement(ChannelHeaderSkeleton, props))
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(skeletonCount)
    if (props.compactActions) expect(html).not.toContain("h-5 w-px")
  })
})
