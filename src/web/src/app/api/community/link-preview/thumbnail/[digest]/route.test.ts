import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const DIGEST = "a".repeat(64)
const SOURCE = "https://images.example.com/og.jpg"
let sourceDigest = ""
const mockR2Get = vi.fn()
const mockR2Put = vi.fn()
const mockKvGet = vi.fn()
const mockKvPut = vi.fn()
const mockCheckRateLimit = vi.fn()
const mockWaitUntil = vi.fn()
const mockImagesInfo = vi.fn()
const mockImagesInput = vi.fn()
const mockImagesTransform = vi.fn()
const mockImagesOutput = vi.fn()
const mockLogError = vi.fn()
let includeKv = true
let includeImages = true

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ ctx: { waitUntil: mockWaitUntil } })),
}))

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

vi.mock("@/lib/logger", () => ({
  log: { error: (...args: unknown[]) => mockLogError(...args) },
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: (...args: any[]) => unknown) => (req: NextRequest, context?: { params?: Record<string, string> }) => {
    const env: Record<string, unknown> = {
      COMMUNITY_MEDIA: { get: mockR2Get, put: mockR2Put },
    }
    if (includeKv) env.CACHE_KV = { get: mockKvGet, put: mockKvPut }
    if (includeImages) {
      env.IMAGES = {
        info: mockImagesInfo,
        input: mockImagesInput,
      }
    }
    return handler(req, {
      env,
      userId: "user_1",
      email: "user@example.com",
      params: context?.params,
    })
  },
}))

import { GET } from "./route"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function stream(bytes: Uint8Array, cancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
    cancel,
  })
}

function manifestObject(overrides: Record<string, unknown> = {}) {
  const value = JSON.stringify({
    version: 1,
    pageDigest: DIGEST,
    sourceUrl: SOURCE,
    sourceDigest,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  })
  return {
    size: value.length,
    body: stream(new TextEncoder().encode(value)),
    text: vi.fn().mockResolvedValue(value),
  }
}

function cachedObject(overrides: Record<string, unknown> = {}) {
  return {
    size: 3,
    body: stream(new Uint8Array([4, 5, 6])),
    httpMetadata: { contentType: "image/webp" },
    customMetadata: { sourceDigest, expiresAt: String(Date.now() + 60_000) },
    ...overrides,
  }
}

function request(digest = DIGEST, query = ""): Promise<Response> {
  return GET(
    new NextRequest(`http://localhost/api/community/link-preview/thumbnail/${digest}${query}`),
    { params: { digest } },
  )
}

describe("GET /api/community/link-preview/thumbnail/[digest]", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    includeKv = true
    includeImages = true
    mockCheckRateLimit.mockResolvedValue({ allowed: true })
    mockKvGet.mockResolvedValue(null)
    mockKvPut.mockResolvedValue(undefined)
    mockR2Put.mockResolvedValue(undefined)
    mockR2Get.mockImplementation((key: string) => {
      if (key.endsWith("manifest.json")) return Promise.resolve(manifestObject())
      return Promise.resolve(null)
    })
    mockImagesInfo.mockResolvedValue({ format: "image/jpeg", fileSize: 3, width: 1200, height: 630 })
    mockImagesTransform.mockReturnThis()
    mockImagesOutput.mockResolvedValue({
      contentType: () => "image/webp",
      image: () => stream(new Uint8Array([7, 8, 9])),
    })
    mockImagesInput.mockReturnValue({
      transform: (...args: unknown[]) => {
        mockImagesTransform(...args)
        return { output: (...values: unknown[]) => mockImagesOutput(...values) }
      },
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/jpeg" },
    })))

    // The fixture source digest must exactly match the production SHA-256.
    const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SOURCE))
    sourceDigest = Array.from(new Uint8Array(digestBytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
    expect(sourceDigest).toHaveLength(64)
    mockR2Get.mockImplementation((key: string) => {
      if (key.endsWith("manifest.json")) return Promise.resolve(manifestObject({ sourceDigest }))
      return Promise.resolve(null)
    })
  })

  it("rejects an invalid digest before R2, rate limiting, or any outbound fetch", async () => {
    const response = await request("../source")

    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(mockR2Get).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mockLogError).not.toHaveBeenCalled()
  })

  it.each([
    ["missing", null],
    ["expired", manifestObject({ expiresAt: 1 })],
    ["mismatched", manifestObject({ pageDigest: "c".repeat(64) })],
  ])("returns the same no-store 404 for a %s manifest with zero outbound work", async (_label, object) => {
    mockR2Get.mockResolvedValueOnce(object)

    const response = await request()

    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mockImagesInfo).not.toHaveBeenCalled()
  })

  it("returns the same no-store 404 when the manifest read fails", async () => {
    mockR2Get.mockRejectedValueOnce(new Error("R2 unavailable"))

    const response = await request()

    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith("link_preview_thumbnail_failure", expect.objectContaining({
      stage: "storage",
      disposition: "transient",
    }))
  })

  it("serves a valid R2 WebP hit without rate limiting, network, or Images work", async () => {
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(cachedObject({ customMetadata: { sourceDigest, expiresAt: String(Date.now() + 60_000) } }))

    const response = await request()

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]))
    expect(response.headers.get("content-type")).toBe("image/webp")
    expect(response.headers.get("cache-control")).toBe("private, max-age=21600, immutable")
    expect(response.headers.get("content-disposition")).toBe("inline")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mockImagesInfo).not.toHaveBeenCalled()
  })

  it("uses a valid manifest source only, ignores query inputs, and stores the fixed transformed WebP", async () => {
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(null)

    const response = await request(DIGEST, "?url=https://127.0.0.1/&width=9999&format=svg")

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledWith(SOURCE, expect.objectContaining({ redirect: "manual", credentials: "omit" }))
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), "community:linkPreviewThumbnail", "user_1")
    expect(mockImagesTransform).toHaveBeenCalledWith({ width: 640, height: 360, fit: "cover" })
    expect(mockImagesOutput).toHaveBeenCalledWith({ format: "image/webp", quality: 78, anim: false })
    expect(mockR2Put).toHaveBeenCalledWith(
      `link-preview-thumbnails/v1/${DIGEST}/thumbnail.webp`,
      new Uint8Array([7, 8, 9]),
      expect.objectContaining({
        httpMetadata: expect.objectContaining({ contentType: "image/webp" }),
        customMetadata: expect.objectContaining({ sourceDigest }),
      }),
    )
    expect(JSON.stringify(await response.arrayBuffer())).not.toContain("images.example.com")
  })

  it("refreshes a stale or source-mismatched object after canceling its body", async () => {
    const cancel = vi.fn()
    const stale = cachedObject({
      body: stream(new Uint8Array([1]), cancel),
      customMetadata: { sourceDigest: "c".repeat(64), expiresAt: "1" },
    })
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(stale)

    const response = await request()

    expect(response.status).toBe(200)
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(mockR2Put).toHaveBeenCalledOnce()
  })

  it("continues after a stale object's body refuses cancellation", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("already closed"))
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(cachedObject({
        body: { cancel },
        customMetadata: { sourceDigest: "c".repeat(64), expiresAt: "1" },
      }))

    const response = await request()

    expect(response.status).toBe(200)
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("returns the same no-store 404 when the cached-object read fails", async () => {
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockRejectedValueOnce(new Error("R2 unavailable"))

    const response = await request()

    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith("link_preview_thumbnail_failure", expect.objectContaining({
      stage: "storage",
      disposition: "transient",
    }))
  })

  it("honors the five-minute negative cache before rate limiting or outbound work", async () => {
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(null)
    mockKvGet.mockResolvedValue("1")

    const response = await request()

    expect(response.status).toBe(404)
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rate-limits before cache-miss network and transform work", async () => {
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(null)
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSec: 10 })

    const response = await request()

    expect(response.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
    expect(mockImagesInfo).not.toHaveBeenCalled()
  })

  it("fails closed without optional KV or an Images binding", async () => {
    includeKv = false
    includeImages = false
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(null)

    const response = await request()

    expect(response.status).toBe(404)
    expect(mockCheckRateLimit).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    expect(mockKvGet).not.toHaveBeenCalled()
    expect(mockKvPut).not.toHaveBeenCalled()
    expect(mockWaitUntil).not.toHaveBeenCalled()
  })

  it("treats negative-cache reads and writes as best-effort", async () => {
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(null)
    mockKvGet.mockRejectedValueOnce(new Error("KV read unavailable"))
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/gif" },
    }))
    mockKvPut.mockRejectedValueOnce(new Error("KV write unavailable"))

    const response = await request()
    const backgroundWrite = mockWaitUntil.mock.calls[0]?.[0] as Promise<void>

    expect(response.status).toBe(404)
    expect(mockCheckRateLimit).toHaveBeenCalledOnce()
    expect(mockWaitUntil).toHaveBeenCalledOnce()
    await expect(backgroundWrite).resolves.toBeUndefined()
  })

  it("negative-caches a deterministic rejection while preserving the indistinguishable 404", async () => {
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(null)
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/gif" },
    }))

    const response = await request()

    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(mockKvPut).toHaveBeenCalledOnce()
    expect(mockKvPut).toHaveBeenCalledWith(
      `link-preview-thumbnail-negative:v1:${DIGEST}:${sourceDigest}`,
      "1",
      { expirationTtl: 300 },
    )
    expect(mockWaitUntil).toHaveBeenCalledWith(expect.any(Promise))
    expect(mockLogError).toHaveBeenCalledWith("link_preview_thumbnail_failure", expect.objectContaining({
      stage: "source",
      disposition: "deterministic",
      errorCode: "source_mime",
      pageDigestPrefix: DIGEST.slice(0, 12),
    }))
  })

  it("does not negative-cache source, Images, or R2 transient failures", async () => {
    for (const fail of [
      () => vi.mocked(fetch).mockRejectedValueOnce(new Error("origin unavailable")),
      () => mockImagesInfo.mockRejectedValueOnce(new Error("decode failed")),
      () => mockR2Put.mockRejectedValueOnce(new Error("R2 unavailable")),
    ]) {
      mockR2Get
        .mockResolvedValueOnce(manifestObject({ sourceDigest }))
        .mockResolvedValueOnce(null)
      fail()

      const response = await request()

      expect(response.status).toBe(404)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(mockKvPut).not.toHaveBeenCalled()
      expect(mockWaitUntil).not.toHaveBeenCalled()
      vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
      }))
      mockImagesInfo.mockResolvedValue({ format: "image/jpeg", fileSize: 3, width: 1200, height: 630 })
      mockR2Put.mockResolvedValue(undefined)
    }
    expect(mockLogError).toHaveBeenNthCalledWith(1, "link_preview_thumbnail_failure", expect.objectContaining({
      stage: "source",
      disposition: "transient",
    }))
    expect(mockLogError).toHaveBeenNthCalledWith(2, "link_preview_thumbnail_failure", expect.objectContaining({
      stage: "inspect",
      disposition: "transient",
    }))
    expect(mockLogError).toHaveBeenNthCalledWith(3, "link_preview_thumbnail_failure", expect.objectContaining({
      stage: "storage",
      disposition: "transient",
    }))
  })

  it("bounds R2 persistence at two seconds and safely observes late rejection", async () => {
    vi.useFakeTimers()
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(null)
    mockR2Put.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("late R2 failure")), 3_000)
    }))

    const result = request()
    await vi.waitFor(() => expect(mockR2Put).toHaveBeenCalledOnce(), { interval: 1, timeout: 100 })
    await vi.advanceTimersByTimeAsync(2_000)
    const response = await result

    expect(response.status).toBe(404)
    expect(mockKvPut).not.toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith("link_preview_thumbnail_failure", expect.objectContaining({
      stage: "storage",
      disposition: "transient",
      errorCode: "storage_timeout",
      elapsedMs: 2_000,
    }))
    await vi.advanceTimersByTimeAsync(1_000)
  })

  it("logs only sanitized stage evidence", async () => {
    mockR2Get
      .mockResolvedValueOnce(manifestObject({ sourceDigest }))
      .mockResolvedValueOnce(null)
    vi.mocked(fetch).mockRejectedValueOnce(new Error(`failed ${SOURCE} ${sourceDigest}`))

    await request()

    const serialized = JSON.stringify(mockLogError.mock.calls)
    expect(serialized).toContain("link_preview_thumbnail_failure")
    expect(serialized).toContain(DIGEST.slice(0, 12))
    expect(serialized).not.toContain(SOURCE)
    expect(serialized).not.toContain(sourceDigest)
    expect(serialized).not.toContain(`link-preview-thumbnails/v1/${DIGEST}`)
  })
})
