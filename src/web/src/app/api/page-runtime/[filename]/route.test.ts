import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGet = vi.fn()
const mockCloudflareContext = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...args: unknown[]) => mockCloudflareContext(...args),
}))

import { GET } from "./route"

const VALID_FILE = "alook-page-runtime-0.16.3-a325e46c37f9-b8a6621d4f5a.tar.gz"

function makeR2Object(bytes: Uint8Array, sha256 = "e6809b5258747a31c0eb2d3a48e258ffbc066870386244e66f61de6b3394e1fd") {
  const cancel = vi.fn(async () => {})
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
    cancel,
  })
  return {
    body,
    size: bytes.byteLength,
    httpEtag: `"${sha256}"`,
    customMetadata: { sha256 },
    cancel,
  }
}

describe("GET /api/page-runtime/[filename]", () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockCloudflareContext.mockReset()
    mockCloudflareContext.mockResolvedValue({ env: { COMMUNITY_MEDIA: { get: mockGet } } })
  })

  it("streams a pinned runtime tarball from R2 with immutable cache headers", async () => {
    const payload = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02])
    const obj = makeR2Object(payload)
    mockGet.mockResolvedValueOnce(obj)

    const req = new NextRequest(`https://alook.ai/api/page-runtime/${VALID_FILE}`)
    const res = await GET(req, { params: Promise.resolve({ filename: VALID_FILE }) })

    expect(res.status).toBe(200)
    expect(mockGet).toHaveBeenCalledWith(`page-runtime/${VALID_FILE}`)
    expect(res.headers.get("content-type")).toBe("application/gzip")
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("etag")).toBe('"e6809b5258747a31c0eb2d3a48e258ffbc066870386244e66f61de6b3394e1fd"')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload)
  })

  it("returns 304 Not Modified and cancels the R2 stream when If-None-Match matches", async () => {
    const obj = makeR2Object(new Uint8Array([1, 2, 3]))
    mockGet.mockResolvedValueOnce(obj)

    const req = new NextRequest(`https://alook.ai/api/page-runtime/${VALID_FILE}`, {
      headers: { "if-none-match": '"e6809b5258747a31c0eb2d3a48e258ffbc066870386244e66f61de6b3394e1fd"' },
    })
    const res = await GET(req, { params: Promise.resolve({ filename: VALID_FILE }) })

    expect(res.status).toBe(304)
    expect(obj.cancel).toHaveBeenCalledOnce()
  })

  it.each([
    "../page-covers/page_1",
    "alook-page-runtime-0.16.3-bad.tar.gz",
    "random.tar.gz",
    "alook-page-runtime-0.16.3-a325e46c37f9-b8a6621d4f5a.zip",
  ])("rejects invalid filename %s with 404 before touching R2", async (badName) => {
    const req = new NextRequest(`https://alook.ai/api/page-runtime/${encodeURIComponent(badName)}`)
    const res = await GET(req, { params: Promise.resolve({ filename: badName }) })

    expect(res.status).toBe(404)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("returns 404 when the requested runtime archive is not uploaded yet", async () => {
    mockGet.mockResolvedValueOnce(null)
    const req = new NextRequest(`https://alook.ai/api/page-runtime/${VALID_FILE}`)
    const res = await GET(req, { params: Promise.resolve({ filename: VALID_FILE }) })
    expect(res.status).toBe(404)
  })
})
