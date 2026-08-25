import { afterEach, describe, expect, it, vi } from "vitest"
import {
  LINK_PREVIEW_LIMITS,
  fetchLinkPreview,
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
    "http://localhost/",
    "http://service.internal/",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/",
    "http://172.16.0.1/",
    "http://192.168.0.1/",
    "http://198.18.0.1/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[2001:db8::1]/",
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
})

describe("fetchLinkPreview", () => {
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
      .rejects.toThrow("preview metadata missing")
  })
})
