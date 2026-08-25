import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { tid } from "@/lib/community/testids"
import { LinkPreviewCardView, linkPreviewStaleTime } from "./link-preview-card"

describe("LinkPreviewCardView", () => {
  it("renders a safe thumbnail in the shared Card as one external link without metadata", () => {
    const html = renderToStaticMarkup(createElement(LinkPreviewCardView, {
      preview: {
        url: "https://github.com/alookai/alook/pull/511",
        hostname: "github.com",
        siteName: "GitHub",
        title: "Pull Request #511",
        description: "Rooms for people and agents.",
        thumbnailUrl: "/api/community/link-preview/thumbnail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }))

    expect(html).toContain('href="https://github.com/alookai/alook/pull/511"')
    expect(html).toContain(`data-testid="${tid.linkPreviewCard}"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('aria-label="Open link preview: Pull Request #511"')
    expect(html).toContain('data-slot="card"')
    expect(html).toContain('class="pb-2"')
    expect(html).toContain("w-full max-w-108")
    expect(html).toContain("pointer-events-none absolute top-2 right-2")
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain(">GitHub<")
    expect(html).not.toContain("Rooms for people and agents.")
  })

  it("keeps positive previews fresh for 6h but retries negative results after 5m", () => {
    expect(linkPreviewStaleTime({ preview: {
      url: "https://example.com/",
      hostname: "example.com",
      title: "Example",
    } })).toBe(6 * 60 * 60 * 1_000)
    expect(linkPreviewStaleTime({ preview: null })).toBe(5 * 60 * 1_000)
    expect(linkPreviewStaleTime(undefined)).toBe(5 * 60 * 1_000)
    expect(linkPreviewStaleTime({ preview: {
      url: "https://example.com/",
      hostname: "example.com",
      title: "Recoverable image",
    }, staleTimeSeconds: 300 })).toBe(5 * 60 * 1_000)
  })

  it("does not create a redundant text card when there is no safe thumbnail", () => {
    const html = renderToStaticMarkup(createElement(LinkPreviewCardView, {
      preview: {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        hostname: "www.youtube.com",
        siteName: "YouTube",
        title: "A YouTube video",
      },
    }))

    expect(html).toBe("")
  })

  it("renders only the same-origin thumbnail path and never the upstream image URL", () => {
    const html = renderToStaticMarkup(createElement(LinkPreviewCardView, {
      preview: {
        url: "https://github.com/alookai/alook/pull/511",
        hostname: "github.com",
        title: "Pull Request #511",
        thumbnailUrl: "/api/community/link-preview/thumbnail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    }))

    expect(html).toContain(`data-testid="${tid.linkPreviewThumbnail}"`)
    expect(html).toContain('src="/api/community/link-preview/thumbnail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
    expect(html).toContain('width="640"')
    expect(html).toContain('height="360"')
    expect(html).not.toContain("avatars.githubusercontent.com")
  })

  it("removes the whole redundant card after an image load failure", () => {
    let renderer: ReactTestRenderer
    act(() => {
      renderer = create(createElement(LinkPreviewCardView, { preview: {
        url: "https://example.com/story",
        hostname: "example.com",
        title: "Story",
        thumbnailUrl: "/api/community/link-preview/thumbnail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      } }))
    })

    const image = renderer!.root.findByType("img")
    act(() => image.props.onError())
    expect(renderer!.root.findAllByType("img")).toHaveLength(0)
    expect(renderer!.root.findAllByType("a")).toHaveLength(0)
    expect(renderer!.root.findAll(
      (node) => node.type === "div" && node.props.className === "pb-2",
    )).toHaveLength(0)
  })
})
