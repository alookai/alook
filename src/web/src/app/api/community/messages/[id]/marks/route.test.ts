import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockMarkMessage = vi.fn()
const mockUnmarkMessage = vi.fn()
const mockIsMessageMarked = vi.fn()
const mockGetMessage = vi.fn()
const mockRequireMessageSurfaceAccess = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMessageMark: {
        markMessage: (...args: unknown[]) => mockMarkMessage(...args),
        unmarkMessage: (...args: unknown[]) => mockUnmarkMessage(...args),
        isMessageMarked: (...args: unknown[]) => mockIsMessageMarked(...args),
      },
      communityMessage: {
        getMessage: (...args: unknown[]) => mockGetMessage(...args),
      },
    },
  }
})

vi.mock("@/lib/community/permissions", () => ({
  requireMessageSurfaceAccess: (...args: unknown[]) => mockRequireMessageSurfaceAccess(...args),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    if (req.headers.get("authorization")?.startsWith("Bearer crk_")) {
      const { NextResponse } = require("next/server")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { PUT, DELETE, GET } from "./route"

const ctx = { params: { id: "m1" } }

function putReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/messages/m1/marks", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

function botReq(method: "PUT" | "DELETE") {
  return new NextRequest("http://localhost/api/community/messages/m1/marks", {
    method,
    headers: { authorization: "Bearer crk_test" },
    ...(method === "PUT" ? { body: JSON.stringify({ channelId: "c1" }) } : {}),
  })
}

// PUT = toggle-on. messageId in the path, channelId in the body (the
// membership + belongs-to-channel gate). Byte-identical to the former flat
// POST /marks except the message id moved flat→path.
describe("PUT /api/community/messages/[id]/marks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "c1" } },
    })
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "c1" })
    mockMarkMessage.mockResolvedValue(undefined)
  })

  it("marks a visible message for the current user, self-scoped to ctx.userId", async () => {
    const res = await PUT(putReq({ channelId: "c1" }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockMarkMessage).toHaveBeenCalledWith({}, {
      userId: "u1",
      channelId: "c1",
      messageId: "m1",
    })
  })

  it("is idempotent — a re-mark still returns ok (markMessage no-ops on conflict)", async () => {
    await PUT(putReq({ channelId: "c1" }), ctx)
    const res = await PUT(putReq({ channelId: "c1" }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("404s when the message does not belong to the claimed channel", async () => {
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "other" })
    const res = await PUT(putReq({ channelId: "c1" }), ctx)
    expect(res.status).toBe(404)
    expect(mockMarkMessage).not.toHaveBeenCalled()
  })

  it("404s when the message does not exist", async () => {
    mockGetMessage.mockResolvedValue(null)
    const res = await PUT(putReq({ channelId: "c1" }), ctx)
    expect(res.status).toBe(404)
    expect(mockMarkMessage).not.toHaveBeenCalled()
  })

  it("forwards the message-surface gate — a non-member cannot mark", async () => {
    mockRequireMessageSurfaceAccess.mockResolvedValue({ ok: false, error: "forbidden", status: 403 })
    const res = await PUT(putReq({ channelId: "c1" }), ctx)
    expect(res.status).toBe(403)
    expect(mockGetMessage).not.toHaveBeenCalled()
    expect(mockMarkMessage).not.toHaveBeenCalled()
  })

  it("rejects a blocked human DM before loading or marking its message", async () => {
    mockRequireMessageSurfaceAccess.mockResolvedValue({ ok: false, error: "blocked", status: 403 })
    const res = await PUT(putReq({ channelId: "dm1" }), ctx)
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: "blocked" })
    expect(mockRequireMessageSurfaceAccess).toHaveBeenCalledWith({}, "dm1", "u1")
    expect(mockGetMessage).not.toHaveBeenCalled()
    expect(mockMarkMessage).not.toHaveBeenCalled()
  })

  it("400s on missing channelId", async () => {
    expect((await PUT(putReq({}), ctx)).status).toBe(400)
  })

  it("keeps the standalone mark mutation door human-only", async () => {
    const res = await PUT(botReq("PUT"), ctx)
    expect(res.status).toBe(401)
    expect(mockMarkMessage).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/community/messages/[id]/marks", () => {
  beforeEach(() => vi.clearAllMocks())

  it("unmarks self-scoped to ctx.userId and returns ok", async () => {
    mockUnmarkMessage.mockResolvedValue({ id: "mk1" })
    const res = await DELETE(new NextRequest("http://localhost/api/community/messages/m1/marks", { method: "DELETE" }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockUnmarkMessage).toHaveBeenCalledWith({}, { userId: "u1", messageId: "m1" })
  })

  it("returns ok even when nothing was deleted (another user's mark = 0-row no-op)", async () => {
    mockUnmarkMessage.mockResolvedValue(null)
    const res = await DELETE(new NextRequest("http://localhost/api/community/messages/m1/marks", { method: "DELETE" }), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("keeps the standalone unmark door human-only", async () => {
    const res = await DELETE(botReq("DELETE"), ctx)
    expect(res.status).toBe(401)
    expect(mockUnmarkMessage).not.toHaveBeenCalled()
  })
})

describe("GET /api/community/messages/[id]/marks", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns {marked:true} when the current user marked the message", async () => {
    mockIsMessageMarked.mockResolvedValue(true)
    const res = await GET(new NextRequest("http://localhost/api/community/messages/m1/marks"), ctx)
    expect(await res.json()).toEqual({ marked: true })
    // self-scoped: the query is asked "did u1 mark m1", never "did anyone".
    expect(mockIsMessageMarked).toHaveBeenCalledWith({}, "u1", "m1")
  })

  it("returns {marked:false} when the current user has not marked it", async () => {
    mockIsMessageMarked.mockResolvedValue(false)
    const res = await GET(new NextRequest("http://localhost/api/community/messages/m1/marks"), ctx)
    expect(await res.json()).toEqual({ marked: false })
  })

  it("keeps the isMarked GET human-only so a crk_ cannot create a fourth bot face", async () => {
    const res = await GET(new NextRequest("http://localhost/api/community/messages/m1/marks", {
      headers: { Authorization: "Bearer crk_test" },
    }), ctx)
    expect(res.status).toBe(401)
    expect(mockIsMessageMarked).not.toHaveBeenCalled()
  })
})
