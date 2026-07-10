import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mediaGet = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {}, COMMUNITY_MEDIA: { get: (...a: unknown[]) => mediaGet(...a) } } })),
}))

let isAuthed = true

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    if (!isAuthed) {
      const { NextResponse } = require("next/server")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, {
      env: { DB: {}, COMMUNITY_MEDIA: { get: (...a: unknown[]) => mediaGet(...a) } },
      userId: "caller",
      email: "u@t.com",
      params,
    })
  },
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

function getReq() {
  return new NextRequest("http://localhost/api/community/users/u1/avatar", { method: "GET" })
}
function ctx(userId?: string) {
  return { params: Promise.resolve(userId ? { userId } : {}) } as any
}

describe("GET /api/community/users/[userId]/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    mediaGet.mockResolvedValue({
      body: new ReadableStream(),
      httpMetadata: { contentType: "image/webp" },
      httpEtag: '"etag-1"',
    })
  })

  it("returns 401 for anonymous callers", async () => {
    isAuthed = false
    const res = await GET(getReq(), ctx("u1"))
    expect(res.status).toBe(401)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("serves the avatar by the deterministic user-avatar/{userId} key for ANY authenticated caller (not just self)", async () => {
    const res = await GET(getReq(), ctx("u1"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/webp")
    expect(mediaGet).toHaveBeenCalledWith("user-avatar/u1")
  })

  it("returns 400 when the userId route param is missing", async () => {
    const res = await GET(getReq(), ctx(undefined))
    expect(res.status).toBe(400)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("returns 404 when the R2 object is missing", async () => {
    mediaGet.mockResolvedValue(null)
    const res = await GET(getReq(), ctx("u1"))
    expect(res.status).toBe(404)
  })

  it("revalidates on every request instead of a long max-age (deterministic key never changes on re-upload)", async () => {
    const res = await GET(getReq(), ctx("u1"))
    expect(res.headers.get("Cache-Control")).toBe("no-cache, must-revalidate")
    expect(res.headers.get("ETag")).toBe('"etag-1"')
  })

  it("returns 304 with no body when If-None-Match matches the current ETag", async () => {
    const req = new NextRequest("http://localhost/api/community/users/u1/avatar", {
      method: "GET",
      headers: { "if-none-match": '"etag-1"' },
    })
    const res = await GET(req, ctx("u1"))
    expect(res.status).toBe(304)
    expect(res.headers.get("ETag")).toBe('"etag-1"')
  })

  it("returns 200 with the full body when If-None-Match is stale", async () => {
    const req = new NextRequest("http://localhost/api/community/users/u1/avatar", {
      method: "GET",
      headers: { "if-none-match": '"stale-etag"' },
    })
    const res = await GET(req, ctx("u1"))
    expect(res.status).toBe(200)
  })
})
