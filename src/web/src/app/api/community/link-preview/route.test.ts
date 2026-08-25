import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const mockFetchLinkPreview = vi.fn()
const mockCheckRateLimit = vi.fn()
const mockKvGet = vi.fn()
const mockKvPut = vi.fn()
const mockWaitUntil = vi.fn()

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

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: (...args: any[]) => unknown) => (req: NextRequest) => handler(req, {
    env: { CACHE_KV: { get: mockKvGet, put: mockKvPut } },
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
    }))

    const response = await POST(request({ url: "https://example.com/#fragment" }))
    expect(await response.json()).toEqual({
      preview: { url: "https://example.com/", hostname: "example.com", title: "Cached" },
    })
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "community:linkPreview",
      "user_1",
    )
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
  })

  it("returns a cached negative preview without fetching the origin", async () => {
    mockKvGet.mockResolvedValue(JSON.stringify({ preview: null }))

    const response = await POST(request({ url: "https://example.com/" }))

    expect(await response.json()).toEqual({ preview: null })
    expect(mockFetchLinkPreview).not.toHaveBeenCalled()
    expect(mockKvPut).not.toHaveBeenCalled()
  })

  it("treats a malformed cache entry as a miss", async () => {
    mockKvGet.mockResolvedValue("not-json")

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
      expect.stringMatching(/^link-preview:v1:[a-f0-9]{64}$/),
      JSON.stringify({
        preview: { url: "https://example.com/", hostname: "example.com", title: "Example" },
      }),
      { expirationTtl: 21_600 },
    )
    expect(mockWaitUntil).toHaveBeenCalledWith(expect.any(Promise))
  })

  it("negative-caches a bounded origin failure and degrades to no card", async () => {
    mockFetchLinkPreview.mockRejectedValue(new Error("timeout"))

    const response = await POST(request({ url: "https://example.com/" }))

    expect(await response.json()).toEqual({ preview: null })
    expect(mockKvPut).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify({ preview: null }),
      { expirationTtl: 300 },
    )
  })

  it("swallows a background KV write failure", async () => {
    mockKvPut.mockRejectedValue(new Error("KV unavailable"))

    const response = await POST(request({ url: "https://example.com/" }))
    const backgroundWrite = mockWaitUntil.mock.calls[0]?.[0] as Promise<void>

    expect((await response.json()).preview.title).toBe("Example")
    await expect(backgroundWrite).resolves.toBeUndefined()
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
