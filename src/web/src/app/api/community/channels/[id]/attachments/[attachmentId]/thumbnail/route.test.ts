import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockAuthorizeAttachment = vi.fn()
const mockR2Get = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@/lib/community/attachment-authorization", () => ({
  authorizeAttachment: (...args: unknown[]) => mockAuthorizeAttachment(...args),
}))
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: NextRequest, ctx: any) => handler(req, {
    params: ctx.params,
    actor: { kind: "human", userId: "u1", email: "u@example.test", isBot: false },
    env: { DB: {}, COMMUNITY_MEDIA: { get: (...args: unknown[]) => mockR2Get(...args) } },
  }),
}))

import { GET } from "./route"

const request = new NextRequest("http://localhost/api/community/channels/c1/attachments/a1/thumbnail")
const ctx = { params: { id: "c1", attachmentId: "a1" } } as any

describe("GET attachment thumbnail", () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    { authz: { ok: false }, label: "unauthorized" },
    { authz: { ok: true, row: { thumbnailR2Key: null } }, label: "legacy row" },
  ])("returns enumeration-safe 404 for $label", async ({ authz }) => {
    mockAuthorizeAttachment.mockResolvedValue(authz)
    const response = await GET(request, ctx)
    expect(response.status).toBe(404)
    expect(mockR2Get).not.toHaveBeenCalled()
  })

  it("returns 502 when a declared thumbnail object is missing", async () => {
    mockAuthorizeAttachment.mockResolvedValue({ ok: true, row: { thumbnailR2Key: "key.thumb" } })
    mockR2Get.mockResolvedValue(null)
    expect((await GET(request, ctx)).status).toBe(502)
  })

  it("serves private immutable JPEG bytes with nosniff", async () => {
    const body = new ReadableStream()
    mockAuthorizeAttachment.mockResolvedValue({ ok: true, row: { thumbnailR2Key: "key.thumb" } })
    mockR2Get.mockResolvedValue({ body })
    const response = await GET(request, ctx)
    expect(response.status).toBe(200)
    expect(mockR2Get).toHaveBeenCalledWith("key.thumb")
    expect(response.headers.get("Content-Type")).toBe("image/jpeg")
    expect(response.headers.get("Content-Disposition")).toBe("inline")
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })
})
