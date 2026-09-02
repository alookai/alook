import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { DmHeader, DmHeaderSkeleton } from "./dm-header"

const dm = {
  id: "dm-1",
  userId: "user-bob",
  name: "Bob",
  discriminator: "0042",
  avatar: "B",
  status: "online" as const,
  preview: "hello",
}

describe("DmHeader", () => {
  it.each(["h1", "div"] as const)("exposes stable header and %s title contracts", (titleAs) => {
    const markup = renderToStaticMarkup(createElement(DmHeader, { dm, titleAs }))

    expect(markup).toContain(`data-testid="${tid.dmHeader}"`)
    expect(markup).toContain(`data-testid="${tid.dmHeaderTitle}"`)
    expect(markup).toContain(`<${titleAs}`)
    expect(markup).toContain("Bob")
    expect(markup).toContain("#0042")
  })

  it("uses one mobile-only parent control without changing DM identity", () => {
    const onBack = vi.fn()
    const markup = renderToStaticMarkup(createElement(DmHeader, { dm, onBack }))

    expect(markup).toContain('aria-label="Back"')
    expect(markup).toMatch(/class="[^"]*size-11[^"]*sm:hidden[^"]*"/)
    expect(markup).toContain(`data-testid="${tid.dmHeaderTitle}"`)
  })
})

describe("DmHeaderSkeleton", () => {
  it("reserves avatar, title, notification, and optional Back footprints", () => {
    const desktop = renderToStaticMarkup(createElement(DmHeaderSkeleton))
    expect(desktop).toContain("size-6 rounded-full")
    expect(desktop).toContain("h-4 w-32 rounded")
    expect(desktop).toContain('data-slot="message-header-actions"')
    expect(desktop).toContain("size-7 rounded-md")
    expect(desktop).not.toContain('aria-label="Back"')

    const mobile = renderToStaticMarkup(
      createElement(DmHeaderSkeleton, { onBack: vi.fn() }),
    )
    expect(mobile).toContain('data-slot="loading-mobile-leading"')
    expect(mobile).toMatch(/class="[^"]*size-11[^"]*sm:hidden[^"]*"/)
    expect(mobile).toContain('data-slot="message-header-identity"')
    expect(mobile).toContain('data-slot="message-header-actions"')
    expect(mobile).not.toContain("<button")
    expect(mobile).not.toContain('aria-label="Back"')
  })
})
