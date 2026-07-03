import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetServer = vi.fn()
const mockUpdateServer = vi.fn()
const mockGetMember = vi.fn()
const mockHandleServerIconUpload = vi.fn()

const mediaGet = vi.fn()
const mediaDelete = vi.fn()
const mediaList = vi.fn()
const mediaPut = vi.fn()
const mockWaitUntil = vi.fn<(promise: Promise<unknown>) => void>()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: {
      DB: {},
      COMMUNITY_MEDIA: {
        get: (...a: unknown[]) => mediaGet(...a),
        put: (...a: unknown[]) => mediaPut(...a),
        delete: (...a: unknown[]) => mediaDelete(...a),
        list: (...a: unknown[]) => mediaList(...a),
      },
    },
    ctx: { waitUntil: (p: Promise<unknown>) => mockWaitUntil(p) },
  })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityServer: {
        getServer: (...a: unknown[]) => mockGetServer(...a),
        updateServer: (...a: unknown[]) => mockUpdateServer(...a),
      },
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
      },
    },
  }
})

vi.mock("@/lib/community/upload", () => ({
  handleServerIconUpload: (...a: unknown[]) => mockHandleServerIconUpload(...a),
}))

// Flip between "authed" and "anonymous" per test to exercise `withAuth`.
let isAuthed = true

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    if (!isAuthed) {
      const { NextResponse } = require("next/server")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, {
      env: {
        DB: {},
        COMMUNITY_MEDIA: {
          get: (...a: unknown[]) => mediaGet(...a),
          put: (...a: unknown[]) => mediaPut(...a),
          delete: (...a: unknown[]) => mediaDelete(...a),
          list: (...a: unknown[]) => mediaList(...a),
        },
      },
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
  return new NextRequest("http://localhost/api/community/servers/s1/icon", { method: "GET" })
}
function postReq() {
  return new NextRequest("http://localhost/api/community/servers/s1/icon", { method: "POST" })
}
function ctx() {
  return { params: Promise.resolve({ id: "s1" }) } as any
}

describe("GET /api/community/servers/[id]/icon", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    mockGetServer.mockResolvedValue({ id: "s1", icon: "server-icon/s1/abc" })
    mediaGet.mockResolvedValue({
      body: new ReadableStream(),
      httpMetadata: { contentType: "image/webp" },
    })
  })

  it("returns 401 for anonymous callers", async () => {
    isAuthed = false
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(401)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("serves the icon by direct R2 key (no LIST)", async () => {
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/webp")
    expect(mediaGet).toHaveBeenCalledWith("server-icon/s1/abc")
    expect(mediaList).not.toHaveBeenCalled()
  })

  it("returns 200 for any authed user (no membership check)", async () => {
    // The route intentionally does not gate by membership — mirrors
    // `media/[...key]` treatment of `server-icon`.
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(200)
    expect(mockGetMember).not.toHaveBeenCalled()
  })

  it("returns 404 when the server row has no icon key", async () => {
    mockGetServer.mockResolvedValue({ id: "s1", icon: null })
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(404)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("returns 404 when the R2 object is missing", async () => {
    mediaGet.mockResolvedValue(null)
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(404)
  })
})

describe("POST /api/community/servers/[id]/icon", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", role: "owner" })
    mockGetServer.mockResolvedValue({ id: "s1", icon: null })
    mockUpdateServer.mockImplementation(async (_db, id, changes) => ({
      id,
      icon: changes.icon,
    }))
    mockHandleServerIconUpload.mockResolvedValue({
      ok: true,
      id: "new-id",
      key: "server-icon/s1/new-id",
      url: "/api/community/media/server-icon/s1/new-id",
      filename: "icon.png",
      contentType: "image/png",
      size: 100,
    })
    mediaDelete.mockResolvedValue(undefined)
  })

  it("stores the R2 key (not a URL) into communityServer.icon", async () => {
    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toBe("/api/community/servers/s1/icon")

    expect(mockUpdateServer).toHaveBeenCalledTimes(1)
    const [, , changes] = mockUpdateServer.mock.calls[0]
    expect(changes.icon).toMatch(/^server-icon\//)
    expect(changes.icon).not.toMatch(/^\/api\//)
  })

  it("deletes the previous R2 object exactly once when replacing an icon", async () => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })

    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)

    expect(mediaDelete).toHaveBeenCalledTimes(1)
    expect(mediaDelete).toHaveBeenCalledWith("server-icon/s1/old")
  })

  it("wraps the previous R2 key delete in ctx.waitUntil", async () => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })

    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)

    // The delete must be handed to waitUntil so the CF runtime keeps the
    // isolate alive past the response — otherwise the R2 delete can be killed
    // mid-flight.
    expect(mockWaitUntil).toHaveBeenCalledTimes(1)
    const promise = mockWaitUntil.mock.calls[0][0]
    expect(promise).toBeInstanceOf(Promise)
    await expect(promise).resolves.toBeUndefined()
    expect(mediaDelete).toHaveBeenCalledWith("server-icon/s1/old")
  })

  it("does not call waitUntil when there is no previous key to delete", async () => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: null })

    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)
    expect(mockWaitUntil).not.toHaveBeenCalled()
    expect(mediaDelete).not.toHaveBeenCalled()
  })

  it("does not delete legacy URL-shaped previous values", async () => {
    // Rows that predate the migration hold `/api/community/servers/…` — the
    // `startsWith("server-icon/")` guard should skip them.
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: "/api/community/servers/s1/icon" })

    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)
    expect(mediaDelete).not.toHaveBeenCalled()
  })

  it("does not delete when the new key equals the previous key", async () => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/new-id" })

    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)
    expect(mediaDelete).not.toHaveBeenCalled()
  })
})
