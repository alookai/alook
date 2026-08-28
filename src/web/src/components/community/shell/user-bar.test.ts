import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { UserBar, UserBarSkeleton } from "./user-bar"
import { tid } from "@/lib/community/testids"

describe("UserBar", () => {
  it("keeps the name shrinkable and truncated while the action group stays fixed", () => {
    const html = renderToStaticMarkup(createElement(UserBar, {
      user: {
        id: "u1",
        name: "A display name that is intentionally much longer than the available sidebar width",
        avatar: "A",
      },
    }))

    expect(html).toContain('data-testid="community-user-bar"')
    expect(html).toContain('class="w-full min-w-0 max-w-full shrink-0 overflow-hidden px-3 pb-3 pt-0"')
    expect(html).toContain('class="flex min-w-0 flex-1 items-center gap-2"')
    expect(html).toContain('data-testid="community-user-bar-name"')
    expect(html).toContain('class="truncate text-sm font-medium leading-tight"')
    expect(html).toContain('class="flex shrink-0 items-center gap-1"')
  })

  it("provides an inert account-neutral placeholder with the same outer geometry", () => {
    const html = renderToStaticMarkup(createElement(UserBarSkeleton))
    expect(html).toContain(`data-testid="${tid.initialUserBarPending}"`)
    expect(html).toContain("aria-hidden=\"true\"")
    expect(html).toContain('class="w-full min-w-0 max-w-full shrink-0 overflow-hidden px-3 pb-3 pt-0"')
    expect(html).not.toContain("<button")
    expect(html).not.toContain("<a")
  })
})
