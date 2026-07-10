import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mediaGet = vi.fn()
const mockGetBotOwnedBy = vi.fn()
const mockUpdateBot = vi.fn()
const mockHandleBotAvatarUpload = vi.fn()

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
        updateBot: (...a: unknown[]) => mockUpdateBot(...a),
      },
    },
  }
})

vi.mock("@/lib/community/upload", () => ({
  handleBotAvatarUpload: (...a: unknown[]) => mockHandleBotAvatarUpload(...a),
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

function getReq() {
  return new NextRequest("http://localhost/api/community/bots/b1/avatar", { method: "GET" })
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

  it("serves the avatar by the deterministic bot-avatar/{botId} key with no ownership check (DM peers/members need it)", async () => {
    const res = await GET(getReq(), ctx("b1"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/webp")
    expect(mediaGet).toHaveBeenCalledWith("bot-avatar/b1")
    expect(mockGetBotOwnedBy).not.toHaveBeenCalled()
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

  it("revalidates on every request instead of a long max-age (deterministic key never changes on re-upload)", async () => {
    const res = await GET(getReq(), ctx("b1"))
    expect(res.headers.get("Cache-Control")).toBe("no-cache, must-revalidate")
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
  })
})

describe("POST /api/community/bots/[id]/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", ownerId: "u1" })
    mockUpdateBot.mockResolvedValue(undefined)
    mockHandleBotAvatarUpload.mockResolvedValue({
      ok: true,
      id: "b1",
      key: "bot-avatar/b1",
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
    expect(mockUpdateBot).not.toHaveBeenCalled()
  })

  it("uploads and updates the bot's image to the routable avatar URL", async () => {
    const res = await POST(postReq(), ctx("b1"))
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toBe("/api/community/bots/b1/avatar")
    expect(mockUpdateBot).toHaveBeenCalledWith(expect.anything(), "b1", "u1", { image: "/api/community/bots/b1/avatar" })
  })
})
