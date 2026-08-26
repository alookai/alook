import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { LinkPreviewCardView, linkPreviewStaleTime } from "./link-preview-card"

const THUMBNAIL_URL = `/api/community/link-preview/thumbnail/${"a".repeat(64)}`
const PREVIEW = {
  url: "https://github.com/alookai/alook/pull/511",
  hostname: "github.com",
  siteName: "GitHub",
  title: "Pull Request #511",
  description: "Rooms for people and agents.",
  thumbnailUrl: THUMBNAIL_URL,
}

afterEach(() => {
  vi.useRealTimers()
})

function renderPreview(preview = PREVIEW): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(LinkPreviewCardView, { preview }))
  })
  return renderer
}

describe("LinkPreviewCardView", () => {
  it("mounts only a layout-free preload until the thumbnail loads, then reveals the existing card", () => {
    const renderer = renderPreview()
    const preload = renderer.root.findByType("img")

    expect(preload.props).toMatchObject({
      "data-testid": tid.linkPreviewThumbnail,
      src: THUMBNAIL_URL,
      alt: "",
      width: 640,
      height: 360,
      loading: "eager",
      decoding: "async",
      referrerPolicy: "no-referrer",
      "aria-hidden": "true",
    })
    expect(preload.props.className).not.toContain("aspect-video")
    expect(renderer.root.findAllByType("a")).toHaveLength(0)
    expect(renderer.root.findAll((node) => node.props["data-testid"] === tid.linkPreviewCard)).toHaveLength(0)
    expect(renderer.root.findAll((node) => node.props["data-slot"] === "card")).toHaveLength(0)

    act(() => preload.props.onLoad())

    const link = renderer.root.findByType("a")
    const image = renderer.root.findByType("img")
    expect(link.props).toMatchObject({
      href: PREVIEW.url,
      target: "_blank",
      rel: "noopener noreferrer",
      "aria-label": "Open link preview: Pull Request #511",
      "data-testid": tid.linkPreviewCard,
    })
    expect(image.props).toMatchObject({
      src: THUMBNAIL_URL,
      loading: "lazy",
      referrerPolicy: "no-referrer",
      className: "aspect-video w-full bg-muted object-cover",
    })
    expect(renderer.root.findAll((node) => node.props["data-slot"] === "card")).toHaveLength(1)
    expect(renderer.root.findAll((node) => node.type === "div" && node.props.className === "pb-2")).toHaveLength(1)
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

  it("retries the identical digest URL after one and three seconds, then stops", async () => {
    vi.useFakeTimers()
    const renderer = renderPreview()
    const first = renderer.root.findByType("img")

    act(() => first.props.onError())
    await act(() => vi.advanceTimersByTimeAsync(999))
    expect(renderer.root.findByType("img")).toBe(first)
    await act(() => vi.advanceTimersByTimeAsync(1))
    const second = renderer.root.findByType("img")
    expect(second).not.toBe(first)
    expect(second.props.src).toBe(THUMBNAIL_URL)
    expect(second.props.src).not.toContain("?")

    act(() => second.props.onError())
    await act(() => vi.advanceTimersByTimeAsync(2_999))
    expect(renderer.root.findByType("img")).toBe(second)
    await act(() => vi.advanceTimersByTimeAsync(1))
    const third = renderer.root.findByType("img")
    expect(third).not.toBe(second)
    expect(third.props.src).toBe(THUMBNAIL_URL)

    act(() => third.props.onError())
    expect(renderer.root.findAllByType("img")).toHaveLength(0)
    expect(renderer.root.findAllByType("a")).toHaveLength(0)
  })

  it("cancels a pending retry on success, URL change, and unmount", async () => {
    vi.useFakeTimers()
    const renderer = renderPreview()
    const first = renderer.root.findByType("img")
    act(() => first.props.onError())
    act(() => first.props.onLoad())
    await act(() => vi.advanceTimersByTimeAsync(5_000))
    expect(renderer.root.findByType("a").props.href).toBe(PREVIEW.url)

    const nextThumbnailUrl = `/api/community/link-preview/thumbnail/${"b".repeat(64)}`
    act(() => {
      renderer.update(createElement(LinkPreviewCardView, {
        preview: { ...PREVIEW, url: "https://example.com/next", thumbnailUrl: nextThumbnailUrl },
      }))
    })
    const nextPreload = renderer.root.findByType("img")
    expect(nextPreload.props.src).toBe(nextThumbnailUrl)
    expect(renderer.root.findAllByType("a")).toHaveLength(0)

    act(() => nextPreload.props.onError())
    act(() => renderer.unmount())
    await act(() => vi.advanceTimersByTimeAsync(5_000))
  })

  it("never places an upstream image URL in the DOM", () => {
    const renderer = renderPreview()
    expect(JSON.stringify(renderer.toJSON())).toContain(THUMBNAIL_URL)
    expect(JSON.stringify(renderer.toJSON())).not.toContain("avatars.githubusercontent.com")
  })
})
