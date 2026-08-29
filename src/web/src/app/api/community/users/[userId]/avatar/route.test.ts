import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mediaGet = vi.fn()
const mockGetLiveHumanAvatarState = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {}, COMMUNITY_MEDIA: { get: (...a: unknown[]) => mediaGet(...a) } } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      user: {
        ...actual.queries.user,
        getLiveHumanAvatarState: (...a: unknown[]) => mockGetLiveHumanAvatarState(...a),
      },
    },
  }
})

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

function getReq(version?: number) {
  const suffix = version === undefined ? "" : `?v=${version}`
  return new NextRequest(`http://localhost/api/community/users/u1/avatar${suffix}`, { method: "GET" })
}
function ctx(userId?: string) {
  return { params: Promise.resolve(userId ? { userId } : {}) } as any
}

describe("GET /api/community/users/[userId]/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    mockGetLiveHumanAvatarState.mockResolvedValue({
      avatarVersion: 0,
      avatarObjectKey: null,
    })
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

  it("returns 404 before R2 for an inconsistent version/object-key pair", async () => {
    mockGetLiveHumanAvatarState.mockResolvedValue({
      avatarVersion: 4,
      avatarObjectKey: null,
    })

    const res = await GET(getReq(4), ctx("u1"))

    expect(res.status).toBe(404)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("redirects a stable versioned URL to the authoritative immutable version", async () => {
    mockGetLiveHumanAvatarState.mockResolvedValue({
      avatarVersion: 3,
      avatarObjectKey: "user-avatar/u1/objects/object-3",
    })

    const res = await GET(getReq(), ctx("u1"))

    expect(res.status).toBe(307)
    expect(res.headers.get("Location")).toBe("/api/community/users/u1/avatar?v=3")
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("serves only the authoritative immutable child for the matching version", async () => {
    mockGetLiveHumanAvatarState.mockResolvedValue({
      avatarVersion: 3,
      avatarObjectKey: "user-avatar/u1/objects/object-3",
    })

    const res = await GET(getReq(3), ctx("u1"))

    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable")
    expect(mediaGet).toHaveBeenCalledWith("user-avatar/u1/objects/object-3")
  })

  it("redirects a version query away from a legacy alias", async () => {
    const res = await GET(getReq(3), ctx("u1"))

    expect(res.status).toBe(307)
    expect(res.headers.get("Location")).toBe("/api/community/users/u1/avatar")
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("serves cached bytes while revalidating the deterministic URL in the background", async () => {
    const res = await GET(getReq(), ctx("u1"))
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, stale-while-revalidate=31536000")
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
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, stale-while-revalidate=31536000")
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
