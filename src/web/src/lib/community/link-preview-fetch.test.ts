import { afterEach, describe, expect, it, vi } from "vitest"
import * as linkPreviewMobile from "link-preview-js/mobile"
import {
  LINK_PREVIEW_LIMITS,
  fetchLinkPreview,
  LinkPreviewFetchError,
  normalizePublicPreviewUrl,
} from "./link-preview-fetch"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("normalizePublicPreviewUrl", () => {
  it("canonicalizes public HTTP(S) URLs and removes fragments", () => {
    expect(normalizePublicPreviewUrl("HTTPS://Example.COM/path?q=1#private").href)
      .toBe("https://example.com/path?q=1")
  })

  it.each([
    ["https://8.8.8.8/path#private", "https://8.8.8.8/path"],
    ["https://[2606:4700:4700::1111]/dns#private", "https://[2606:4700:4700::1111]/dns"],
  ])("accepts a globally routable literal address: %s", (input, expected) => {
    expect(normalizePublicPreviewUrl(input).href).toBe(expected)
  })

  it.each([
    "http://localhost/",
    "http://service.internal/",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/",
    "http://172.16.0.1/",
    "http://192.168.0.1/",
    "http://192.0.0.1/",
    "http://192.0.2.1/",
    "http://192.88.99.1/",
    "http://198.18.0.1/",
    "http://198.51.100.1/",
    "http://203.0.113.1/",
    "http://224.0.0.1/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[2001:db8::1]/",
    "http://[2001::1]/",
    "http://[2001:2::1]/",
    "http://[2001:d::1]/",
    "http://[2001:10::1]/",
    "http://[2002::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
  ])("rejects non-public targets: %s", (url) => {
    expect(() => normalizePublicPreviewUrl(url)).toThrow("non-public preview host")
  })

  it.each([
    "file:///etc/passwd",
    "https://user:secret@example.com/",
    "https://example.com:8443/",
  ])("rejects unsupported URL authority/protocol shapes: %s", (url) => {
    expect(() => normalizePublicPreviewUrl(url)).toThrow()
  })

  it.each([
    "",
    "not a URL",
    `https://example.com/${"x".repeat(2_048)}`,
  ])("rejects an empty, malformed, or oversized URL: %s", (url) => {
    expect(() => normalizePublicPreviewUrl(url)).toThrow("invalid preview URL")
  })
})

describe("fetchLinkPreview", () => {
  it("uses bounded YouTube oEmbed metadata instead of scanning oversized HTML", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      title: "A YouTube video",
      provider_name: "YouTube",
      author_name: "Example creator",
    }), { headers: { "content-type": "application/json; charset=utf-8" } }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchLinkPreview("https://www.youtube.com/watch?v=dQw4w9WgXcQ#chapter")).resolves.toEqual({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      hostname: "www.youtube.com",
      title: "A YouTube video",
      siteName: "YouTube",
      description: "Example creator",
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json",
    )
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
    })
  })

  it("keeps a validated YouTube thumbnail URL internal to the server result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      title: "A YouTube video",
      provider_name: "YouTube",
      thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    }), { headers: { "content-type": "application/json" } })))

    await expect(fetchLinkPreview("https://youtu.be/dQw4w9WgXcQ")).resolves.toMatchObject({
      title: "A YouTube video",
      thumbnailSource: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    })
  })

  it.each([
    "https://youtu.be/dQw4w9WgXcQ?t=5",
    "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ])("extracts a legal video id from an explicit supported shape: %s", async (url) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      title: "Supported video shape",
      provider_name: "YouTube",
    }), { headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchLinkPreview(url)).resolves.toMatchObject({ title: "Supported video shape" })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json",
    )
  })

  it("caps YouTube oEmbed bodies and cancels the oversized stream", async () => {
    const cancel = vi.fn()
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(LINK_PREVIEW_LIMITS.maxOEmbedBytes + 1))
      },
      cancel,
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(oversized, {
      headers: { "content-type": "application/json" },
    }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchLinkPreview("https://youtu.be/dQw4w9WgXcQ"))
      .rejects.toThrow("preview response is too large")
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects a bodyless YouTube oEmbed response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
      headers: { "content-type": "application/json" },
    })))

    await expect(fetchLinkPreview("https://youtu.be/dQw4w9WgXcQ"))
      .rejects.toThrow("preview response has no body")
  })

  it("rejects YouTube oEmbed JSON without a meaningful title", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      provider_name: "YouTube",
      author_name: "Example creator",
    }), { headers: { "content-type": "application/json" } })))

    await expect(fetchLinkPreview("https://youtu.be/dQw4w9WgXcQ"))
      .rejects.toMatchObject({
        message: "YouTube oEmbed metadata missing",
        stage: "metadata_parse",
        code: "metadata_missing",
        httpStatus: 200,
      })
  })

  it("classifies malformed provider JSON as metadata parsing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{", {
      headers: { "content-type": "application/json" },
    })))

    await expect(fetchLinkPreview("https://youtu.be/dQw4w9WgXcQ"))
      .rejects.toMatchObject({
        stage: "metadata_parse",
        code: "metadata_parse_failed",
        httpStatus: 200,
      })
  })

  it.each([
    "https://youtube.example.org/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/",
    "https://www.youtube.com/@alookai",
    "https://www.youtube.com/watch?v=too-short",
  ])("does not use oEmbed for a non-video YouTube shape: %s", async (url) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      "<html><head><meta property='og:title' content='Generic HTML'></head></html>",
      { headers: { "content-type": "text/html" } },
    ))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchLinkPreview(url)).resolves.toMatchObject({ title: "Generic HTML" })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(new URL(url).href)
  })

  it("does not follow an oEmbed redirect, including one toward a private target", async () => {
    const cancel = vi.fn()
    const redirectBody = new ReadableStream<Uint8Array>({ cancel })
    const fetchMock = vi.fn().mockResolvedValue(new Response(redirectBody, {
      status: 302,
      headers: { location: "http://127.0.0.1/metadata" },
    }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchLinkPreview("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
      .rejects.toThrow("YouTube oEmbed rejected request")
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects and cancels an oEmbed response with the wrong MIME type", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      headers: { "content-type": "text/html" },
    }))
    vi.stubGlobal("fetch", fetchMock)

    const error = await fetchLinkPreview("https://youtu.be/dQw4w9WgXcQ").catch((caught) => caught)

    expect(error).toBeInstanceOf(LinkPreviewFetchError)
    expect(error).toMatchObject({
      message: "YouTube oEmbed response is not JSON",
      stage: "provider_metadata_fetch",
      code: "unexpected_content_type",
      httpStatus: 200,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("sanitizes and caps malicious oEmbed text without returning remote HTML or media", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      title: `Safe\u202E<script>${"x".repeat(200)}`,
      provider_name: `You\u0007Tube${"y".repeat(100)}`,
      author_name: `Creator\u202E${"z".repeat(100)}`,
      html: "<iframe src='https://attacker.invalid'></iframe>",
      thumbnail_url: "https://attacker.invalid/image.png",
    }), { headers: { "content-type": "application/json" } })))

    const preview = await fetchLinkPreview("https://youtu.be/dQw4w9WgXcQ")

    expect(preview.title).toHaveLength(160)
    expect(preview.siteName).toHaveLength(80)
    expect(preview.description).toHaveLength(80)
    expect(`${preview.title}${preview.siteName}${preview.description}`).not.toMatch(/[\u0007\u202E]/)
    expect(preview).not.toHaveProperty("html")
    expect(preview).not.toHaveProperty("thumbnail_url")
  })

  it("applies the single total timeout while waiting for YouTube oEmbed", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })))

    const preview = fetchLinkPreview("https://youtu.be/dQw4w9WgXcQ")
    const rejected = expect(preview).rejects.toMatchObject({
      message: "aborted",
      stage: "provider_metadata_fetch",
      code: "timeout",
    })
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_LIMITS.timeoutMs)

    await rejected
  })

  it("follows bounded manual redirects, revalidates them, and sanitizes metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://www.example.com/final" },
      }))
      .mockResolvedValueOnce(new Response(
        "<html><head>"
          + "<meta property='og:site_name' content=' Example  Site '>"
          + "<meta property='og:title' content='Safe\u202E title'>"
          + "<meta name='description' content='  A   useful description  '>"
          + "</head><body>ignored</body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchLinkPreview("https://example.com/start#fragment")).resolves.toEqual({
      url: "https://example.com/start",
      hostname: "example.com",
      title: "Safe title",
      description: "A useful description",
      siteName: "Example Site",
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
      referrerPolicy: "no-referrer",
    })
  })

  it("rejects a redirect that moves to a private target before fetching it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchLinkPreview("https://example.com/start"))
      .rejects.toThrow("non-public preview host")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects and cancels a redirect without a location", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 302 })))

    await expect(fetchLinkPreview("https://example.com/start"))
      .rejects.toThrow("invalid preview redirect")
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("revalidates every redirect hop before the next fetch", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://example.org/second" },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchLinkPreview("https://example.com/start"))
      .rejects.toThrow("non-public preview host")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("caps redirect chains and cancels every unused redirect body", async () => {
    const cancel = vi.fn()
    const redirectBody = () => new ReadableStream<Uint8Array>({ cancel })
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(redirectBody(), {
      status: 302,
      headers: { location: "https://example.com/again" },
    })))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchLinkPreview("https://example.com/start"))
      .rejects.toThrow("too many preview redirects")
    expect(fetchMock).toHaveBeenCalledTimes(LINK_PREVIEW_LIMITS.maxRedirects + 1)
    expect(cancel).toHaveBeenCalledTimes(LINK_PREVIEW_LIMITS.maxRedirects + 1)
  })

  it("parses the bounded head of a large page instead of rejecting its body size", async () => {
    const head = "<html><head><meta property='og:title' content='Large page'></head>"
    const oversized = head + "x".repeat(LINK_PREVIEW_LIMITS.maxHtmlBytes * 2)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(oversized, {
      headers: {
        "content-type": "text/html",
        "content-length": String(oversized.length),
      },
    })))

    await expect(fetchLinkPreview("https://github.com/alookai/alook/pull/1"))
      .resolves.toMatchObject({ title: "Large page", hostname: "github.com" })
  })

  it("stops a chunked response without content-length at the actual byte ceiling", async () => {
    const encoder = new TextEncoder()
    const cancel = vi.fn()
    const first = encoder.encode("<html><head><meta property='og:title' content='Chunked page'>")
    const fill = encoder.encode("x".repeat(16 * 1024))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first)
      },
      pull(controller) {
        controller.enqueue(fill)
      },
      cancel,
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: { "content-type": "text/html" },
    })))

    await expect(fetchLinkPreview("https://example.com/chunked"))
      .resolves.toMatchObject({ title: "Chunked page" })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("uses one timeout budget while waiting for response headers", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })))

    const preview = fetchLinkPreview("https://example.com/slow-headers")
    const rejected = expect(preview).rejects.toThrow("aborted")
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_LIMITS.timeoutMs)

    await rejected
  })

  it("uses the same timeout budget while a streamed body stalls", async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => Promise.resolve(new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("<html><head><meta property='og:title' content='Slow'>"))
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true })
        },
      }),
      { headers: { "content-type": "text/html" } },
    ))))

    const preview = fetchLinkPreview("https://example.com/slow-body")
    const rejected = expect(preview).rejects.toThrow("aborted")
    await vi.advanceTimersByTimeAsync(LINK_PREVIEW_LIMITS.timeoutMs)

    await rejected
  })

  it("rejects a bodyless HTML response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
      headers: { "content-type": "text/html" },
    })))

    await expect(fetchLinkPreview("https://example.com/bodyless"))
      .rejects.toThrow("preview response has no body")
  })

  it("rejects and cancels a non-success HTML response", async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 503 })))

    await expect(fetchLinkPreview("https://example.com/unavailable"))
      .rejects.toMatchObject({
        message: "preview origin rejected request",
        stage: "document_fetch",
        code: "upstream_http_status",
        httpStatus: 503,
      })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects non-HTML responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      headers: { "content-type": "application/json" },
    })))

    await expect(fetchLinkPreview("https://example.com/data"))
      .rejects.toThrow("preview response is not HTML")
  })

  it("falls back to Twitter Card metadata when Open Graph tags are absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<html><head>"
        + "<meta name='twitter:title' content='Twitter-only title'>"
        + "<meta name='twitter:description' content='Twitter-only description'>"
        + "</head></html>",
      { headers: { "content-type": "text/html" } },
    )))

    await expect(fetchLinkPreview("https://example.com/twitter-only")).resolves.toMatchObject({
      title: "Twitter-only title",
      description: "Twitter-only description",
    })
  })

  it("selects the first public HTTPS Open Graph image resolved against the final page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<html><head>"
        + "<meta property='og:title' content='With image'>"
        + "<meta property='og:image' content='/assets/card.png#fragment'>"
        + "</head></html>",
      { headers: { "content-type": "text/html" } },
    )))

    await expect(fetchLinkPreview("https://example.com/post")).resolves.toMatchObject({
      title: "With image",
      thumbnailSource: "https://example.com/assets/card.png",
    })
  })

  it("falls back to a Twitter image without exposing insecure or private candidates", async () => {
    const html = (image: string) => "<html><head>"
      + "<meta name='twitter:title' content='Twitter-only'>"
      + `<meta name='twitter:image' content='${image}'>`
      + "</head></html>"

    for (const [image, expected] of [
      ["https://cdn.example.org/card.webp", "https://cdn.example.org/card.webp"],
      ["http://cdn.example.org/card.webp", undefined],
      ["https://127.0.0.1/card.webp", undefined],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html(image), {
        headers: { "content-type": "text/html" },
      })))
      const preview = await fetchLinkPreview("https://example.com/twitter-image")
      expect(preview.thumbnailSource).toBe(expected)
    }
  })

  it("removes controls and bidi markers and caps every returned field", async () => {
    const title = `T\u202E${"a".repeat(200)}`
    const description = `D\u0007${"b".repeat(400)}`
    const siteName = `S${"c".repeat(100)}`
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `<html><head><meta property='og:title' content='${title}'>`
        + `<meta property='og:description' content='${description}'>`
        + `<meta property='og:site_name' content='${siteName}'></head></html>`,
      { headers: { "content-type": "text/html" } },
    )))

    const preview = await fetchLinkPreview("https://example.com/capped")

    expect(preview.title).toHaveLength(160)
    expect(preview.description).toHaveLength(320)
    expect(preview.siteName).toHaveLength(80)
    expect(`${preview.title}${preview.description}${preview.siteName}`).not.toMatch(/[\u0007\u202E]/)
  })

  it("rejects an HTML page with no meaningful preview metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<html><head></head><body>Untitled</body></html>",
      { headers: { "content-type": "text/html" } },
    )))

    await expect(fetchLinkPreview("https://example.com/untitled"))
      .rejects.toMatchObject({
        message: "preview metadata missing",
        stage: "metadata_parse",
        code: "metadata_missing",
      })
  })

  it("classifies an HTML metadata parser failure", async () => {
    vi.spyOn(linkPreviewMobile, "getPreviewFromContent")
      .mockRejectedValueOnce(new Error("parser failed"))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<html><head><title>Example</title></head></html>",
      { headers: { "content-type": "text/html" } },
    )))

    await expect(fetchLinkPreview("https://example.com/parser-failure"))
      .rejects.toMatchObject({
        message: "parser failed",
        stage: "metadata_parse",
        code: "metadata_parse_failed",
      })
  })
})
