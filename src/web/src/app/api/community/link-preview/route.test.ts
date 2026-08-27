import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const mockFetchLinkPreview = vi.fn()
const mockCheckRateLimit = vi.fn()
const mockKvGet = vi.fn()
const mockKvPut = vi.fn()
const mockR2Put = vi.fn()
const mockWaitUntil = vi.fn()
const mockLogError = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ ctx: { waitUntil: mockWaitUntil } })),
}))

vi.mock("@/lib/community/link-preview-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/link-preview-fetch")>(
    "@/lib/community/link-preview-fetch",
  )
  return {
    ...actual,
    fetchLinkPreview: (...args: unknown[]) => mockFetchLinkPreview(...args),
  }
})

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

vi.mock("@/lib/logger", () => ({
  log: { error: (...args: unknown[]) => mockLogError(...args) },
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: (...args: any[]) => unknown) => (req: NextRequest) => handler(req, {
    env: {
      CACHE_KV: { get: mockKvGet, put: mockKvPut },
      COMMUNITY_MEDIA: { put: mockR2Put },
    },
    userId: "user_1",
    email: "user@example.com",
  }),
}))

vi.mock("@/lib/middleware/helpers", () => ({
  writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
  writeError: (message: string, status: number, headers?: HeadersInit) =>
    NextResponse.json({ error: message }, { status, headers }),
}))

import { POST } from "./route"
import { LinkPreviewFetchError } from "@/lib/community/link-preview-fetch"

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/community/link-preview", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

function rawRequest(body: BodyInit, headers?: HeadersInit): NextRequest {
  return new NextRequest("http://localhost/api/community/link-preview", {
    method: "POST",
    body,
    headers,
  })
}

describe("POST /api/community/link-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue({ allowed: true })
    mockKvGet.mockResolvedValue(null)
    mockKvPut.mockResolvedValue(undefined)
    mockR2Put.mockResolvedValue(undefined)
    mockFetchLinkPreview.mockResolvedValue({
      url: "https://example.com/",
      hostname: "example.com",
      title: "Example",
    })
  })

  it("rate-limits before rejecting an invalid target", async () => {
    const response = await POST(request({ url: "http://127.0.0.1/private" }))

    expect(response.status).toBe(400)
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "community:linkPreview",
      "user_1",
    )
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
  })

  it("rejects an oversized declared body after applying the rate limit", async () => {
    const response = await POST(rawRequest("{}", { "content-length": "4097" }))

    expect(response.status).toBe(413)
    expect(mockCheckRateLimit).toHaveBeenCalledOnce()
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
  })

  it("streams and rejects an oversized body when content-length is absent", async () => {
    const req = rawRequest("x".repeat(4097), { "content-type": "application/json" })
    expect(req.headers.get("content-length")).toBeNull()

    const response = await POST(req)

    expect(response.status).toBe(413)
    expect(mockCheckRateLimit).toHaveBeenCalledOnce()
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON only after applying the rate limit", async () => {
    const response = await POST(rawRequest("{"))

    expect(response.status).toBe(400)
    expect(mockCheckRateLimit).toHaveBeenCalledOnce()
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
  })

  it("rejects a request with no body only after applying the rate limit", async () => {
    const req = new NextRequest("http://localhost/api/community/link-preview", { method: "POST" })

    const response = await POST(req)

    expect(response.status).toBe(400)
    expect(mockCheckRateLimit).toHaveBeenCalledOnce()
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
  })

  it("returns a valid cached preview without fetching the origin", async () => {
    mockKvGet.mockResolvedValue(JSON.stringify({
      preview: { url: "https://example.com/", hostname: "example.com", title: "Cached" },
      staleTimeSeconds: 21_600,
    }))

    const response = await POST(request({ url: "https://example.com/#fragment" }))
    expect(await response.json()).toEqual({
      preview: { url: "https://example.com/", hostname: "example.com", title: "Cached" },
      staleTimeSeconds: 21_600,
    })
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "community:linkPreview",
      "user_1",
    )
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
  })

  it("returns a cached negative preview without fetching the origin", async () => {
    mockKvGet.mockResolvedValue(JSON.stringify({ preview: null, staleTimeSeconds: 300 }))

    const response = await POST(request({ url: "https://example.com/" }))

    expect(await response.json()).toEqual({ preview: null, staleTimeSeconds: 300 })
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
    expect(mockKvPut).not.toHaveBeenCalled()
  })

  it("returns a valid degraded cached preview with its exact digest path", async () => {
    const thumbnailUrl = "/api/community/link-preview/thumbnail/0f115db062b7c0dd030b16878c99dea5c354b49dc37b38eb8846179c7783e9d7"
    mockKvGet.mockResolvedValue(JSON.stringify({
      preview: {
        url: "https://example.com/",
        hostname: "example.com",
        title: "Cached",
        thumbnailUrl,
      },
      staleTimeSeconds: 300,
    }))

    const response = await POST(request({ url: "https://example.com/" }))

    expect(await response.json()).toEqual({
      preview: {
        url: "https://example.com/",
        hostname: "example.com",
        title: "Cached",
        thumbnailUrl,
      },
      staleTimeSeconds: 300,
    })
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
  })

  it.each([
    ["an unsupported TTL", "/api/community/link-preview/thumbnail/0f115db062b7c0dd030b16878c99dea5c354b49dc37b38eb8846179c7783e9d7", 123],
    ["an upstream image URL", "https://images.example.com/og.jpg", 21_600],
    ["a mismatched digest path", `/api/community/link-preview/thumbnail/${"a".repeat(64)}`, 21_600],
  ])("treats a cached preview with %s as a miss", async (_label, thumbnailUrl, staleTimeSeconds) => {
    mockKvGet.mockResolvedValue(JSON.stringify({
      preview: {
        url: "https://example.com/",
        hostname: "example.com",
        title: "Unsafe cache entry",
        thumbnailUrl,
      },
      staleTimeSeconds,
    }))

    const response = await POST(request({ url: "https://example.com/" }))

    expect((await response.json()).preview.title).toBe("Example")
    expect(mockFetchLinkPreview).toHaveBeenCalledOnce()
  })

  it("treats a malformed cache entry as a miss", async () => {
    mockKvGet.mockResolvedValue("not-json")

    const response = await POST(request({ url: "https://example.com/" }))

    expect((await response.json()).preview.title).toBe("Example")
    expect(mockFetchLinkPreview).toHaveBeenCalledOnce()
  })

  it("treats a cached primitive preview as a miss", async () => {
    mockKvGet.mockResolvedValue(JSON.stringify({
      preview: "not-an-object",
      staleTimeSeconds: 21_600,
    }))

    const response = await POST(request({ url: "https://example.com/" }))

    expect((await response.json()).preview.title).toBe("Example")
    expect(mockFetchLinkPreview).toHaveBeenCalledOnce()
  })

  it("degrades a KV read failure to a bounded origin fetch", async () => {
    mockKvGet.mockRejectedValue(new Error("KV unavailable"))

    const response = await POST(request({ url: "https://example.com/" }))

    expect((await response.json()).preview.title).toBe("Example")
    expect(mockFetchLinkPreview).toHaveBeenCalledOnce()
  })

  it("fetches a cache miss and schedules the sanitized result for KV", async () => {
    const response = await POST(request({ url: "https://example.com/" }))

    expect(await response.json()).toMatchObject({ preview: { title: "Example" } })
    expect(mockFetchLinkPreview).toHaveBeenCalledWith("https://example.com/")
    expect(mockKvPut).toHaveBeenCalledWith(
      expect.stringMatching(/^link-preview:v2:[a-f0-9]{64}$/),
      JSON.stringify({
        preview: { url: "https://example.com/", hostname: "example.com", title: "Example" },
        staleTimeSeconds: 21_600,
      }),
      { expirationTtl: 21_600 },
    )
    expect(mockWaitUntil).toHaveBeenCalledWith(expect.any(Promise))
    expect(mockLogError).not.toHaveBeenCalled()
  })

  it("negative-caches a bounded origin failure and degrades to no card", async () => {
    mockFetchLinkPreview.mockRejectedValue(new LinkPreviewFetchError(
      "origin unavailable",
      "document_fetch",
      "upstream_http_status",
      503,
    ))

    const response = await POST(request({ url: "https://example.com/" }))

    expect(await response.json()).toEqual({ preview: null, staleTimeSeconds: 300 })
    expect(mockKvPut).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify({ preview: null, staleTimeSeconds: 300 }),
      { expirationTtl: 300 },
    )
    expect(mockLogError).toHaveBeenCalledOnce()
    expect(mockLogError).toHaveBeenCalledWith("link_preview_failure", expect.objectContaining({
      stage: "document_fetch",
      errorCode: "upstream_http_status",
      httpStatus: 503,
      elapsedMs: expect.any(Number),
      disposition: "negative_cache",
      pageDigestPrefix: "0f115db062b7",
    }))
    const serialized = JSON.stringify(mockLogError.mock.calls[0]?.[1])
    expect(serialized).not.toContain("https://example.com")
    expect(serialized).not.toContain("origin unavailable")
    expect(serialized).not.toContain("user_1")
  })

  it("swallows a background KV write failure", async () => {
    mockKvPut.mockRejectedValue(new Error("KV unavailable"))

    const response = await POST(request({ url: "https://example.com/" }))
    const backgroundWrite = mockWaitUntil.mock.calls[0]?.[0] as Promise<void>

    expect((await response.json()).preview.title).toBe("Example")
    await expect(backgroundWrite).resolves.toBeUndefined()
  })

  it("awaits a private R2 manifest before returning only a same-origin thumbnail path", async () => {
    mockFetchLinkPreview.mockResolvedValue({
      url: "https://example.com/",
      hostname: "example.com",
      title: "Example",
      thumbnailSource: "https://images.example.com/og.png",
    })

    const response = await POST(request({ url: "https://example.com/" }))
    const body = await response.json()

    expect(body).toEqual({
      preview: {
        url: "https://example.com/",
        hostname: "example.com",
        title: "Example",
        thumbnailUrl: "/api/community/link-preview/thumbnail/0f115db062b7c0dd030b16878c99dea5c354b49dc37b38eb8846179c7783e9d7",
      },
      staleTimeSeconds: 21_600,
    })
    expect(JSON.stringify(body)).not.toContain("images.example.com")
    expect(mockR2Put).toHaveBeenCalledWith(
      "link-preview-thumbnails/v1/0f115db062b7c0dd030b16878c99dea5c354b49dc37b38eb8846179c7783e9d7/manifest.json",
      expect.stringContaining('"sourceUrl":"https://images.example.com/og.png"'),
      expect.objectContaining({ httpMetadata: { contentType: "application/json" } }),
    )
    expect(mockR2Put.mock.invocationCallOrder[0]).toBeLessThan(mockKvPut.mock.invocationCallOrder[0]!)
    expect(mockLogError).not.toHaveBeenCalled()
  })

  it("omits a thumbnail and uses the recovery TTL when the manifest write fails", async () => {
    mockFetchLinkPreview.mockResolvedValue({
      url: "https://example.com/",
      hostname: "example.com",
      title: "Example",
      thumbnailSource: "https://images.example.com/og.png",
    })
    mockR2Put.mockRejectedValue(new Error("R2 unavailable"))

    const response = await POST(request({ url: "https://example.com/" }))

    expect(await response.json()).toEqual({
      preview: { url: "https://example.com/", hostname: "example.com", title: "Example" },
      staleTimeSeconds: 300,
    })
    expect(mockKvPut).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"staleTimeSeconds":300'),
      { expirationTtl: 300 },
    )
    expect(mockLogError).toHaveBeenCalledOnce()
    expect(mockLogError).toHaveBeenCalledWith("link_preview_failure", expect.objectContaining({
      stage: "manifest_write",
      errorCode: "manifest_write_failed",
      elapsedMs: expect.any(Number),
      disposition: "text_only_recovery_ttl",
      pageDigestPrefix: "0f115db062b7",
    }))
    const serialized = JSON.stringify(mockLogError.mock.calls[0]?.[1])
    expect(serialized).not.toContain("https://example.com")
    expect(serialized).not.toContain("images.example.com")
    expect(serialized).not.toContain("R2 unavailable")
  })

  it("enforces the authenticated preview rate limit", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSec: 17 })

    const response = await POST(rawRequest("not-json"))

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("17")
    expect(mockKvGet).not.toHaveBeenCalled()
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
  })
})
