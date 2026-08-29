import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mediaGet = vi.fn()
const mockGetBotOwnedBy = vi.fn()
const mockGetLiveBotAvatar = vi.fn()
const mockHandleBotAvatarUpload = vi.fn()
const mockPersistUploadedBotAvatar = vi.fn()
const mockEnsureAvatarAliasPresent = vi.fn()
const mockScheduleAvatarMediaReconciliation = vi.fn()
const mockFanOutIdentityUpdate = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {}, COMMUNITY_MEDIA: { get: (...a: unknown[]) => mediaGet(...a) } } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBot: {
        getBotOwnedBy: (...a: unknown[]) => mockGetBotOwnedBy(...a),
        getLiveBotAvatar: (...a: unknown[]) => mockGetLiveBotAvatar(...a),
      },
    },
  }
})

vi.mock("@/lib/community/upload", () => ({
  handleBotAvatarUpload: (...a: unknown[]) => mockHandleBotAvatarUpload(...a),
}))

vi.mock("@/lib/community/bot-avatar-persistence", () => ({
  persistUploadedBotAvatar: (...a: unknown[]) => mockPersistUploadedBotAvatar(...a),
}))

vi.mock("@/lib/community/avatar-media-reconciliation", () => ({
  ensureAvatarAliasPresent: (...a: unknown[]) => mockEnsureAvatarAliasPresent(...a),
  scheduleAvatarMediaReconciliation: (...a: unknown[]) => mockScheduleAvatarMediaReconciliation(...a),
}))

vi.mock("@/lib/community/fanout", () => ({
  fanOutIdentityUpdate: (...a: unknown[]) => mockFanOutIdentityUpdate(...a),
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
      userId: "u1",
      email: "u@t.com",
      params,
    })
  },
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET, POST } from "./route"

function getReq(version?: number) {
  const suffix = version === undefined ? "" : `?v=${version}`
  return new NextRequest(`http://localhost/api/community/bots/b1/avatar${suffix}`, { method: "GET" })
}
function postReq() {
  return new NextRequest("http://localhost/api/community/bots/b1/avatar", { method: "POST" })
}
function ctx(id?: string) {
  return { params: Promise.resolve(id ? { id } : {}) } as any
}

describe("GET /api/community/bots/[id]/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    mockGetLiveBotAvatar.mockResolvedValue({
      id: "b1",
      image: "/api/community/bots/b1/avatar",
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
    const res = await GET(getReq(), ctx("b1"))
    expect(res.status).toBe(401)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("serves a live canonical avatar by the deterministic key without an owner check", async () => {
    const res = await GET(getReq(), ctx("b1"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/webp")
    expect(mediaGet).toHaveBeenCalledWith("bot-avatar/b1")
    expect(mockGetBotOwnedBy).not.toHaveBeenCalled()
    expect(mockGetLiveBotAvatar).toHaveBeenCalledWith(expect.anything(), "b1")
  })

  it("returns 404 before R2 for a missing, tombstoned, or non-bot row", async () => {
    mockGetLiveBotAvatar.mockResolvedValue(null)
    const res = await GET(getReq(), ctx("b1"))
    expect(res.status).toBe(404)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("returns 404 before R2 for a live bot with a noncanonical image", async () => {
    mockGetLiveBotAvatar.mockResolvedValue({
      id: "b1",
      image: "avatar:beam-seed",
      avatarVersion: 0,
      avatarObjectKey: null,
    })
    const res = await GET(getReq(), ctx("b1"))
    expect(res.status).toBe(404)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("returns 404 before R2 for an inconsistent version/object-key pair", async () => {
    mockGetLiveBotAvatar.mockResolvedValue({
      id: "b1",
      image: "/api/community/bots/b1/avatar",
      avatarVersion: 4,
      avatarObjectKey: null,
    })

    const res = await GET(getReq(4), ctx("b1"))

    expect(res.status).toBe(404)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("returns 400 when the bot id route param is missing", async () => {
    const res = await GET(getReq(), ctx(undefined))
    expect(res.status).toBe(400)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("returns 404 when the R2 object is missing", async () => {
    mediaGet.mockResolvedValue(null)
    const res = await GET(getReq(), ctx("b1"))
    expect(res.status).toBe(404)
  })

  it("redirects the stable route to the authoritative immutable version", async () => {
    mockGetLiveBotAvatar.mockResolvedValue({
      id: "b1",
      image: "/api/community/bots/b1/avatar",
      avatarVersion: 4,
      avatarObjectKey: "bot-avatar/b1/objects/object-4",
    })

    const res = await GET(getReq(), ctx("b1"))

    expect(res.status).toBe(307)
    expect(res.headers.get("Location")).toBe("/api/community/bots/b1/avatar?v=4")
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("serves only the authoritative immutable child for the matching version", async () => {
    mockGetLiveBotAvatar.mockResolvedValue({
      id: "b1",
      image: "/api/community/bots/b1/avatar",
      avatarVersion: 4,
      avatarObjectKey: "bot-avatar/b1/objects/object-4",
    })

    const res = await GET(getReq(4), ctx("b1"))

    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable")
    expect(mediaGet).toHaveBeenCalledWith("bot-avatar/b1/objects/object-4")
  })

  it("redirects a version query away from a legacy alias", async () => {
    const res = await GET(getReq(4), ctx("b1"))

    expect(res.status).toBe(307)
    expect(res.headers.get("Location")).toBe("/api/community/bots/b1/avatar")
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("serves cached bytes while revalidating the deterministic URL in the background", async () => {
    const res = await GET(getReq(), ctx("b1"))
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, stale-while-revalidate=31536000")
    expect(res.headers.get("ETag")).toBe('"etag-1"')
  })

  it("returns 304 with no body when If-None-Match matches the current ETag", async () => {
    const req = new NextRequest("http://localhost/api/community/bots/b1/avatar", {
      method: "GET",
      headers: { "if-none-match": '"etag-1"' },
    })
    const res = await GET(req, ctx("b1"))
    expect(res.status).toBe(304)
    expect(res.headers.get("ETag")).toBe('"etag-1"')
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, stale-while-revalidate=31536000")
  })
})

describe("POST /api/community/bots/[id]/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", ownerId: "u1" })
    mockPersistUploadedBotAvatar.mockResolvedValue({
      kind: "persisted",
      avatarVersion: 2,
      avatarObjectKey: "bot-avatar/b1/objects/object-2",
      previousObjectKey: null,
    })
    mockEnsureAvatarAliasPresent.mockResolvedValue(true)
    mockScheduleAvatarMediaReconciliation.mockResolvedValue(undefined)
    mockHandleBotAvatarUpload.mockResolvedValue({
      ok: true,
      id: "b1",
      key: "bot-avatar/b1/objects/object-2",
      url: "/api/community/media/bot-avatar/b1",
      filename: "bot.png",
      contentType: "image/png",
      size: 10,
    })
  })

  it("returns 400 when the bot id route param is missing", async () => {
    const res = await POST(postReq(), ctx(undefined))
    expect(res.status).toBe(400)
    expect(mockHandleBotAvatarUpload).not.toHaveBeenCalled()
  })

  it("returns 404 (bot not found) when the caller does not own the bot — scoped by userId ahead of the query", async () => {
    mockGetBotOwnedBy.mockResolvedValue(null)
    const res = await POST(postReq(), ctx("b1"))
    expect(res.status).toBe(404)
    expect(mockGetBotOwnedBy).toHaveBeenCalledWith(expect.anything(), "b1", "u1")
    expect(mockHandleBotAvatarUpload).not.toHaveBeenCalled()
  })

  it("forwards upload failures unchanged (e.g. 413 too large)", async () => {
    const { NextResponse } = await import("next/server")
    mockHandleBotAvatarUpload.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "avatar too large (max 8MB)" }, { status: 413 }),
    })
    const res = await POST(postReq(), ctx("b1"))
    expect(res.status).toBe(413)
    expect(mockPersistUploadedBotAvatar).not.toHaveBeenCalled()
  })

  it("uploads and updates the bot's image to the routable avatar URL", async () => {
    const res = await POST(postReq(), ctx("b1"))
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; avatarVersion: number }
    expect(body).toEqual({ url: "/api/community/bots/b1/avatar?v=2", avatarVersion: 2 })
    expect(mockPersistUploadedBotAvatar).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { botId: "b1", ownerId: "u1", objectKey: "bot-avatar/b1/objects/object-2" },
    )
    expect(mockFanOutIdentityUpdate).toHaveBeenCalledWith(
      "b1",
      "/api/community/bots/b1/avatar?v=2",
      2,
    )
  })

  it("returns 404 when the upload loses to delete after R2 PUT", async () => {
    mockPersistUploadedBotAvatar.mockResolvedValue({ kind: "not_found" })
    const res = await POST(postReq(), ctx("b1"))
    expect(res.status).toBe(404)
  })

  it("returns 500 for an ambiguous D1 persistence failure", async () => {
    mockPersistUploadedBotAvatar.mockResolvedValue({ kind: "failed" })
    const res = await POST(postReq(), ctx("b1"))
    expect(res.status).toBe(500)
  })

  it("fails closed when the immutable child cannot publish its stable alias", async () => {
    mockEnsureAvatarAliasPresent.mockResolvedValue(false)

    const res = await POST(postReq(), ctx("b1"))

    expect(res.status).toBe(500)
    expect(mockScheduleAvatarMediaReconciliation).not.toHaveBeenCalled()
    expect(mockFanOutIdentityUpdate).not.toHaveBeenCalled()
  })
})
