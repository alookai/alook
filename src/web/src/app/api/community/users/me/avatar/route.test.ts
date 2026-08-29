import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockHandleUserAvatarUpload = vi.fn()
const mockHandleBotAvatarUpload = vi.fn()
const mockGetBotOwnedBy = vi.fn()
const mockPersistUploadedBotAvatar = vi.fn()
const mockAuthUpdateUser = vi.fn()
const mockPublishHumanAvatar = vi.fn()
const mockGetLiveHumanAvatarState = vi.fn()
const mockCleanupAvatarCandidate = vi.fn()
const mockEnsureAvatarAliasPresent = vi.fn()
const mockScheduleAvatarMediaReconciliation = vi.fn()
const mockFanOutIdentityUpdate = vi.fn()

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
      ...actual.queries,
      communityBot: {
        ...actual.queries.communityBot,
        getBotOwnedBy: (...a: unknown[]) => mockGetBotOwnedBy(...a),
      },
      user: {
        ...actual.queries.user,
        publishHumanAvatar: (...a: unknown[]) => mockPublishHumanAvatar(...a),
        getLiveHumanAvatarState: (...a: unknown[]) => mockGetLiveHumanAvatarState(...a),
      },
    },
  }
})

vi.mock("@/lib/community/upload", () => ({
  handleUserAvatarUpload: (...a: unknown[]) => mockHandleUserAvatarUpload(...a),
  handleBotAvatarUpload: (...a: unknown[]) => mockHandleBotAvatarUpload(...a),
}))

vi.mock("@/lib/community/bot-avatar-persistence", () => ({
  persistUploadedBotAvatar: (...a: unknown[]) => mockPersistUploadedBotAvatar(...a),
}))

vi.mock("@/lib/community/avatar-media-reconciliation", () => ({
  cleanupAvatarCandidate: (...a: unknown[]) => mockCleanupAvatarCandidate(...a),
  ensureAvatarAliasPresent: (...a: unknown[]) => mockEnsureAvatarAliasPresent(...a),
  scheduleAvatarMediaReconciliation: (...a: unknown[]) => mockScheduleAvatarMediaReconciliation(...a),
}))

vi.mock("@/lib/community/fanout", () => ({
  fanOutIdentityUpdate: (...a: unknown[]) => mockFanOutIdentityUpdate(...a),
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
      env: { DB: {}, COMMUNITY_MEDIA: { delete: vi.fn() } },
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

function humanUpload(key = "user-avatar/u1/objects/object-1") {
  return {
    ok: true as const,
    id: "u1",
    key,
    url: "/api/community/media/user-avatar/u1",
    filename: "me.png",
    contentType: "image/png",
    size: 10,
  }
}

function botUpload() {
  return {
    ok: true as const,
    id: "b1",
    key: "bot-avatar/b1/objects/object-2",
    url: "/api/community/media/bot-avatar/b1",
    filename: "bot.png",
    contentType: "image/png",
    size: 10,
  }
}

describe("POST /api/community/users/me/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    actorKind = "human"
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", ownerUserId: "u1" })
    mockPersistUploadedBotAvatar.mockResolvedValue({
      kind: "persisted",
      avatarVersion: 2,
      avatarObjectKey: "bot-avatar/b1/objects/object-2",
      previousObjectKey: null,
    })
    mockPublishHumanAvatar.mockResolvedValue({
      previous: { avatarVersion: 0, avatarObjectKey: null },
      current: { avatarVersion: 1, avatarObjectKey: "user-avatar/u1/objects/object-1" },
    })
    mockEnsureAvatarAliasPresent.mockResolvedValue(true)
    mockScheduleAvatarMediaReconciliation.mockResolvedValue(undefined)
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
    expect(mockPersistUploadedBotAvatar).not.toHaveBeenCalled()
    expect(mockAuthUpdateUser).not.toHaveBeenCalled()
  })

  it("uploads for the caller's own userId and refreshes the signed session image", async () => {
    const headers = new Headers()
    headers.append("Set-Cookie", "better-auth.session_data=fresh; Path=/")
    mockAuthUpdateUser.mockResolvedValue({ headers })
    mockHandleUserAvatarUpload.mockResolvedValue({
      ok: true,
      id: "u1",
      key: "user-avatar/u1/objects/object-1",
      url: "/api/community/media/user-avatar/u1",
      filename: "me.png",
      contentType: "image/png",
      size: 10,
    })
    const res = await POST(postReq(), {} as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; avatarVersion: number }
    expect(body).toEqual({ url: "/api/community/users/u1/avatar?v=1", avatarVersion: 1 })

    expect(mockHandleUserAvatarUpload).toHaveBeenCalledWith(expect.anything(), expect.anything(), "u1")
    expect(mockAuthUpdateUser).toHaveBeenCalledWith(expect.objectContaining({
      body: { image: "/api/community/users/u1/avatar" },
      returnHeaders: true,
    }))
    expect(mockPersistUploadedBotAvatar).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toContain("better-auth.session_data=fresh; Path=/")
  })

  it("keeps a successful human response when Better Auth emits no replacement cookie", async () => {
    mockHandleUserAvatarUpload.mockResolvedValue({
      ok: true,
      id: "u1",
      key: "user-avatar/u1/objects/object-1",
      url: "/api/community/media/user-avatar/u1",
      filename: "me.png",
      contentType: "image/png",
      size: 10,
    })

    const res = await POST(postReq(), {} as never)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      url: "/api/community/users/u1/avatar?v=1",
      avatarVersion: 1,
    })
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it("uses the bot avatar key and URL for a bot actor", async () => {
    actorKind = "bot"
    mockHandleBotAvatarUpload.mockResolvedValue({
      ok: true,
      id: "b1",
      key: "bot-avatar/b1/objects/object-2",
      url: "/api/community/bots/b1/avatar",
      filename: "bot.png",
      contentType: "image/png",
      size: 10,
    })
    const res = await POST(postReq(), {} as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      url: "/api/community/bots/b1/avatar?v=2",
      avatarVersion: 2,
    })
    expect(mockHandleBotAvatarUpload).toHaveBeenCalledWith(expect.anything(), expect.anything(), "b1")
    expect(mockHandleUserAvatarUpload).not.toHaveBeenCalled()
    expect(mockGetBotOwnedBy).toHaveBeenCalledWith(expect.anything(), "b1", "u1")
    expect(mockPersistUploadedBotAvatar).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { botId: "b1", ownerId: "u1", objectKey: "bot-avatar/b1/objects/object-2" },
    )
    expect(mockAuthUpdateUser).not.toHaveBeenCalled()
  })

  it("returns 404 before bot R2 PUT when the runner actor no longer owns a live bot", async () => {
    actorKind = "bot"
    mockGetBotOwnedBy.mockResolvedValue(null)

    const res = await POST(postReq(), {} as never)

    expect(res.status).toBe(404)
    expect(mockHandleBotAvatarUpload).not.toHaveBeenCalled()
    expect(mockPersistUploadedBotAvatar).not.toHaveBeenCalled()
  })

  it("forwards bot upload failures before attempting D1 persistence", async () => {
    const { NextResponse } = await import("next/server")
    actorKind = "bot"
    mockHandleBotAvatarUpload.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "avatar too large (max 8MB)" }, { status: 413 }),
    })

    const res = await POST(postReq(), {} as never)

    expect(res.status).toBe(413)
    expect(mockPersistUploadedBotAvatar).not.toHaveBeenCalled()
  })

  it("returns 404 when bot self-upload loses to delete after R2 PUT", async () => {
    actorKind = "bot"
    mockHandleBotAvatarUpload.mockResolvedValue({
      ok: true,
      id: "b1",
      key: "bot-avatar/b1/objects/object-2",
      url: "/api/community/bots/b1/avatar",
      filename: "bot.png",
      contentType: "image/png",
      size: 10,
    })
    mockPersistUploadedBotAvatar.mockResolvedValue({ kind: "not_found" })

    const res = await POST(postReq(), {} as never)
    expect(res.status).toBe(404)
  })

  it("returns 500 when bot self-upload persistence is ambiguous", async () => {
    actorKind = "bot"
    mockHandleBotAvatarUpload.mockResolvedValue({
      ok: true,
      id: "b1",
      key: "bot-avatar/b1/objects/object-2",
      url: "/api/community/bots/b1/avatar",
      filename: "bot.png",
      contentType: "image/png",
      size: 10,
    })
    mockPersistUploadedBotAvatar.mockResolvedValue({ kind: "failed" })

    const res = await POST(postReq(), {} as never)
    expect(res.status).toBe(500)
  })

  it("fails closed when a persisted bot avatar cannot publish its stable alias", async () => {
    actorKind = "bot"
    mockHandleBotAvatarUpload.mockResolvedValue(botUpload())
    mockEnsureAvatarAliasPresent.mockResolvedValue(false)

    const res = await POST(postReq(), {} as never)

    expect(res.status).toBe(500)
    expect(mockScheduleAvatarMediaReconciliation).not.toHaveBeenCalled()
    expect(mockFanOutIdentityUpdate).not.toHaveBeenCalled()
  })

  it("recovers an ambiguous human publish when verification finds the uploaded child current", async () => {
    mockHandleUserAvatarUpload.mockResolvedValue(humanUpload())
    mockPublishHumanAvatar.mockRejectedValue(new Error("D1 response lost"))
    mockGetLiveHumanAvatarState.mockResolvedValue({
      avatarVersion: 3,
      avatarObjectKey: "user-avatar/u1/objects/object-1",
    })

    const res = await POST(postReq(), {} as never)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      url: "/api/community/users/u1/avatar?v=3",
      avatarVersion: 3,
    })
    expect(mockCleanupAvatarCandidate).not.toHaveBeenCalled()
  })

  it("cleans an ambiguous non-current upload and returns 500", async () => {
    mockHandleUserAvatarUpload.mockResolvedValue(humanUpload())
    mockPublishHumanAvatar.mockRejectedValue("D1 response lost")
    mockGetLiveHumanAvatarState.mockResolvedValue({
      avatarVersion: 3,
      avatarObjectKey: "user-avatar/u1/objects/other",
    })

    const res = await POST(postReq(), {} as never)

    expect(res.status).toBe(500)
    expect(mockCleanupAvatarCandidate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { kind: "human", id: "u1" },
      "user-avatar/u1/objects/object-1",
    )
  })

  it("returns 500 when an ambiguous human publish cannot be verified", async () => {
    mockHandleUserAvatarUpload.mockResolvedValue(humanUpload())
    mockPublishHumanAvatar.mockRejectedValue(new Error("D1 response lost"))
    mockGetLiveHumanAvatarState.mockRejectedValue("verification unavailable")

    const res = await POST(postReq(), {} as never)

    expect(res.status).toBe(500)
    expect(mockCleanupAvatarCandidate).not.toHaveBeenCalled()
  })

  it("cleans the uploaded child when the human row disappears during publish", async () => {
    mockHandleUserAvatarUpload.mockResolvedValue(humanUpload())
    mockPublishHumanAvatar.mockResolvedValue(null)

    const res = await POST(postReq(), {} as never)

    expect(res.status).toBe(404)
    expect(mockCleanupAvatarCandidate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { kind: "human", id: "u1" },
      "user-avatar/u1/objects/object-1",
    )
  })

  it("fails closed when a published human avatar cannot publish its stable alias", async () => {
    mockHandleUserAvatarUpload.mockResolvedValue(humanUpload())
    mockEnsureAvatarAliasPresent.mockResolvedValue(false)

    const res = await POST(postReq(), {} as never)

    expect(res.status).toBe(500)
    expect(mockScheduleAvatarMediaReconciliation).not.toHaveBeenCalled()
    expect(mockFanOutIdentityUpdate).not.toHaveBeenCalled()
  })

  it("keeps the published avatar when the session refresh throws", async () => {
    mockHandleUserAvatarUpload.mockResolvedValue(humanUpload())
    mockAuthUpdateUser.mockRejectedValue("session unavailable")

    const res = await POST(postReq(), {} as never)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      url: "/api/community/users/u1/avatar?v=1",
      avatarVersion: 1,
    })
    expect(mockScheduleAvatarMediaReconciliation).toHaveBeenCalledOnce()
    expect(mockFanOutIdentityUpdate).toHaveBeenCalledWith(
      "u1",
      "/api/community/users/u1/avatar?v=1",
      1,
    )
  })
})
