import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { tid } from "@/lib/community/testids"
import { LinkPreviewCardView, linkPreviewStaleTime } from "./link-preview-card"

describe("LinkPreviewCardView", () => {
  it("renders sanitized metadata as one safe external link", () => {
    const html = renderToStaticMarkup(createElement(LinkPreviewCardView, {
      preview: {
        url: "https://github.com/alookai/alook/pull/511",
        hostname: "github.com",
        siteName: "GitHub",
        title: "Pull Request #511",
        description: "Rooms for people and agents.",
      },
    }))

    expect(html).toContain('href="https://github.com/alookai/alook/pull/511"')
    expect(html).toContain(`data-testid="${tid.linkPreviewCard}"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('aria-label="Open link preview: Pull Request #511"')
    expect(html).toContain("GitHub")
    expect(html).toContain("Rooms for people and agents.")
  })

  it("keeps positive previews fresh for 6h but retries negative results after 5m", () => {
    expect(linkPreviewStaleTime({ preview: {
      url: "https://example.com/",
      hostname: "example.com",
      title: "Example",
    } })).toBe(6 * 60 * 60 * 1_000)
    expect(linkPreviewStaleTime({ preview: null })).toBe(5 * 60 * 1_000)
    expect(linkPreviewStaleTime(undefined)).toBe(5 * 60 * 1_000)
  })

  it("renders YouTube metadata through the same text-only generic card", () => {
    const html = renderToStaticMarkup(createElement(LinkPreviewCardView, {
      preview: {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        hostname: "www.youtube.com",
        siteName: "YouTube",
        title: "A YouTube video",
      },
    }))

    expect(html).toContain(`data-testid="${tid.linkPreviewCard}"`)
    expect(html).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
    expect(html).toContain("A YouTube video")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<iframe")
  })
})
