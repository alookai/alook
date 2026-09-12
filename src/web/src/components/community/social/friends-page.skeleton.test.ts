import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FriendsPageSkeleton } from "./friends-page-skeleton"

function renderFriendsPageSkeleton(reserveBackSlot: boolean) {
  return renderToStaticMarkup(createElement(FriendsPageSkeleton, { reserveBackSlot }))
}

describe("FriendsPage loading header", () => {
  it("keeps Back geometry inert until the real page is loaded", () => {
    const html = renderFriendsPageSkeleton(true)

    expect(html).toContain('data-slot="loading-back-placeholder"')
    expect(html).not.toContain("<button")
    expect(html).not.toContain("<input")
    expect(html).not.toContain('aria-label="Back"')
  })

  it("omits Back geometry when the route does not reserve it", () => {
    const html = renderFriendsPageSkeleton(false)

    expect(html).not.toContain('data-slot="loading-back-placeholder"')
    expect(html).not.toContain("<button")
  })
})
