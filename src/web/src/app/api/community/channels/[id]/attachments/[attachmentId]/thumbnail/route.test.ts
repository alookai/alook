import { createImagesBindingStub } from "@/test/fixtures/images-binding"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockAuthorizeAttachment = vi.fn()
const mockR2Get = vi.fn()
const images = createImagesBindingStub()
const pending: Promise<unknown>[] = []
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: async () => ({ ctx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } }) }))
afterEach(async () => { await Promise.all(pending); pending.length = 0; vi.unstubAllGlobals() })

vi.mock("@/lib/db", () => ({ getPrimaryDb: vi.fn(() => ({})) }))
vi.mock("@/lib/community/attachment-authorization", () => ({
  authorizeAttachment: (...args: unknown[]) => mockAuthorizeAttachment(...args),
}))
vi.mock("@/lib/middleware/community-actor", () => ({
  communityActorPolicy: () => ({ resolve: async (req: NextRequest) => ({ context: { actor: { kind: "human", userId: "u1", email: "u@example.test", isBot: false }, env: { DB: {}, IMAGES: images, COMMUNITY_MEDIA: { get: (...args: unknown[]) => mockR2Get(...args) } } } }) }),
}))

import { GET } from "./route"

const request = new NextRequest("http://localhost/api/community/channels/c1/attachments/a1/thumbnail")
const ctx = { params: { id: "c1", attachmentId: "a1" } } as any

describe("GET attachment thumbnail", () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    { authz: { ok: false }, label: "unauthorized" },
    { authz: { ok: true, row: { contentType: "application/pdf", thumbnailR2Key: null } }, label: "non-inline file" },
  ])("returns enumeration-safe 404 for $label", async ({ authz }) => {
    mockAuthorizeAttachment.mockResolvedValue(authz)
    const response = await GET(request, ctx)
    expect(response.status).toBe(404)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mockR2Get).not.toHaveBeenCalled()
  })

  it("returns 502 when the original object is missing", async () => {
    mockAuthorizeAttachment.mockResolvedValue({ ok: true, row: { contentType: "image/png", r2Key: "original", thumbnailR2Key: null } })
    mockR2Get.mockResolvedValue(null)
    expect((await GET(request, ctx)).status).toBe(502)
  })

  it("serves derived private bytes from the original when no historical JPEG key exists", async () => {
    const body = new Response("original").body
    mockAuthorizeAttachment.mockResolvedValue({ ok: true, row: { contentType: "image/png", r2Key: "original", thumbnailR2Key: null } })
    mockR2Get.mockResolvedValue({ body, size: 8, httpEtag: '"original"' })
    const response = await GET(request, ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get("Vary")).toBe("Authorization")
    expect(mockR2Get).toHaveBeenCalledWith("original")
    expect(response.headers.get("Content-Type")).toBe("image/webp")
    expect(response.headers.get("Content-Disposition")).toBe("inline")
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(await response.text()).toBe("derived-image")
  })

  it("checks authorization before looking up a warm derived cache", async () => {
    const entries = new Map<string, Response>()
    const match = vi.fn(async (key: Request) => entries.get(key.url)?.clone())
    vi.stubGlobal("caches", { open: async () => ({ match, put: async (key: Request, value: Response) => {
      entries.set(key.url, new Response(await value.arrayBuffer(), value))
    } }) })
    mockAuthorizeAttachment.mockResolvedValue({ ok: true, row: { contentType: "image/png", r2Key: "original" } })
    mockR2Get.mockImplementation(async () => ({ body: new Response("original").body, size: 8, httpEtag: '"original"' }))
    const first = await GET(request, ctx); await first.arrayBuffer(); await Promise.all(pending)
    expect(entries.size).toBe(1)
    mockAuthorizeAttachment.mockResolvedValue({ ok: false })
    const response = await GET(request, ctx)
    expect(response.status).toBe(404)
    expect(match).toHaveBeenCalledOnce()
    expect(mockR2Get).toHaveBeenCalledOnce()
    expect(images.input).toHaveBeenCalledOnce()
  })

  it("reports an oversized historical image without reading it through Images", async () => {
    mockAuthorizeAttachment.mockResolvedValue({ ok: true, row: { contentType: "image/png", r2Key: "original" } })
    mockR2Get.mockResolvedValue({ body: new Response("original").body, size: 20_000_001 })
    const response = await GET(request, ctx)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: "image_processing_limit" })
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(images.input).not.toHaveBeenCalled()
  })

  it("returns a retryable decode failure and rejects arbitrary variants", async () => {
    mockAuthorizeAttachment.mockResolvedValue({ ok: true, row: { contentType: "image/png", r2Key: "original" } })
    mockR2Get.mockResolvedValue({ body: new Response("original").body, size: 8, httpEtag: '"original"' })
    images.input.mockImplementationOnce(() => { throw new Error("decode failed") })
    const response = await GET(request, ctx)
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ code: "image_processing_unavailable" })
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect((await GET(new NextRequest(`${request.url}?variant=unbounded`), ctx)).status).toBe(400)
    expect(mockR2Get).toHaveBeenCalledOnce()
  })
})
