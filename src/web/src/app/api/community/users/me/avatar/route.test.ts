import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockHandleUserAvatarUpload = vi.fn()
const mockHandleBotAvatarUpload = vi.fn()
const mockUpdateUser = vi.fn()
const mockAuthUpdateUser = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { updateUser: (...a: unknown[]) => mockAuthUpdateUser(...a) },
  })),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      user: {
        updateUser: (...a: unknown[]) => mockUpdateUser(...a),
      },
    },
  }
})

vi.mock("@/lib/community/upload", () => ({
  handleUserAvatarUpload: (...a: unknown[]) => mockHandleUserAvatarUpload(...a),
  handleBotAvatarUpload: (...a: unknown[]) => mockHandleBotAvatarUpload(...a),
}))

let isAuthed = true
let actorKind: "human" | "bot" = "human"

vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    if (!isAuthed) {
      const { NextResponse } = require("next/server")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, {
      env: { DB: {} },
      actor: actorKind === "bot"
        ? { kind: "bot", userId: "b1", ownerUserId: "u1", machineId: "m1" }
        : { kind: "human", userId: "u1", email: "u@t.com" },
      params,
    })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

function postReq() {
  return new NextRequest("http://localhost/api/community/users/me/avatar", { method: "POST" })
}

describe("POST /api/community/users/me/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    actorKind = "human"
    mockUpdateUser.mockResolvedValue(undefined)
    mockAuthUpdateUser.mockResolvedValue({ headers: new Headers() })
  })

  it("rejects unauthenticated requests with 401", async () => {
    isAuthed = false
    const res = await POST(postReq(), {} as never)
    expect(res.status).toBe(401)
    expect(mockHandleUserAvatarUpload).not.toHaveBeenCalled()
    expect(mockAuthUpdateUser).not.toHaveBeenCalled()
  })

  it("forwards upload failures unchanged (e.g. 413 too large)", async () => {
    const { NextResponse } = await import("next/server")
    mockHandleUserAvatarUpload.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "avatar too large (max 8MB)" }, { status: 413 }),
    })
    const res = await POST(postReq(), {} as never)
    expect(res.status).toBe(413)
    expect(mockUpdateUser).not.toHaveBeenCalled()
    expect(mockAuthUpdateUser).not.toHaveBeenCalled()
  })

  it("uploads for the caller's own userId and refreshes the signed session image", async () => {
    const headers = new Headers()
    headers.append("Set-Cookie", "better-auth.session_data=fresh; Path=/")
    mockAuthUpdateUser.mockResolvedValue({ headers })
    mockHandleUserAvatarUpload.mockResolvedValue({
      ok: true,
      id: "u1",
      key: "user-avatar/u1",
      url: "/api/community/media/user-avatar/u1",
      filename: "me.png",
      contentType: "image/png",
      size: 10,
    })
    const res = await POST(postReq(), {} as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toBe("/api/community/users/u1/avatar")

    expect(mockHandleUserAvatarUpload).toHaveBeenCalledWith(expect.anything(), expect.anything(), "u1")
    expect(mockAuthUpdateUser).toHaveBeenCalledWith(expect.objectContaining({
      body: { image: "/api/community/users/u1/avatar" },
      returnHeaders: true,
    }))
    expect(mockUpdateUser).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toContain("better-auth.session_data=fresh; Path=/")
  })

  it("uses the bot avatar key and URL for a bot actor", async () => {
    actorKind = "bot"
    mockHandleBotAvatarUpload.mockResolvedValue({
      ok: true,
      id: "b1",
      key: "bot-avatar/b1",
      url: "/api/community/bots/b1/avatar",
      filename: "bot.png",
      contentType: "image/png",
      size: 10,
    })
    const res = await POST(postReq(), {} as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: "/api/community/bots/b1/avatar" })
    expect(mockHandleBotAvatarUpload).toHaveBeenCalledWith(expect.anything(), expect.anything(), "b1")
    expect(mockHandleUserAvatarUpload).not.toHaveBeenCalled()
    expect(mockUpdateUser).toHaveBeenCalledWith(expect.anything(), "b1", { image: "/api/community/bots/b1/avatar" })
    expect(mockAuthUpdateUser).not.toHaveBeenCalled()
  })
})
