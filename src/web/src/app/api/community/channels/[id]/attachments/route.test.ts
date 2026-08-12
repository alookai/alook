import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockR2Delete = vi.fn(async () => undefined)
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: { DB: {}, COMMUNITY_MEDIA: { put: vi.fn(), delete: (...a: unknown[]) => mockR2Delete(...(a as [])) } },
  })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
// Unified actor: a request with no `crk_` bearer falls through to the human
// withAuth path. Mock Better-Auth to resolve "no session" so a no-auth request
// yields the human-path 401 — the real unified-actor contract.
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: vi.fn(async () => ({ headers: new Headers(), response: null })) },
  })),
}))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockResolveServerByNameForMember = vi.fn()
const mockResolveChannelByNameForMember = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetDM = vi.fn()
const mockGetDMBetween = vi.fn()
const mockCreatePendingAttachment = vi.fn()
const mockLogError = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({ error: (...args: unknown[]) => mockLogError(...args) }),
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityServer: { resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a) },
      communityChannel: {
        resolveChannelByNameForMember: (...a: unknown[]) => mockResolveChannelByNameForMember(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
      },
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
        getDMBetween: (...a: unknown[]) => mockGetDMBetween(...a),
      },
      communityFriendship: { isBlocked: async () => false },
      communityAttachment: {
        createPendingAttachment: (...a: unknown[]) => mockCreatePendingAttachment(...a),
      },
    },
  }
})

const mockHandleAttachmentUpload = vi.fn()
const mockRunAttachmentUpload = vi.fn()
vi.mock("@/lib/community/upload", () => ({
  handleAttachmentUpload: (...a: unknown[]) => mockHandleAttachmentUpload(...a),
  runAttachmentUpload: (...a: unknown[]) => mockRunAttachmentUpload(...a),
}))

import { POST } from "./route"

// The path `[id]` carries the `resolve` placeholder for a bot (it addresses by
// `?target=`); a human puts the real channelId there.
function botReq(target: string | null, headers: Record<string, string> = {}): NextRequest {
  const q = target !== null ? `?target=${encodeURIComponent(target)}` : ""
  return new NextRequest(`http://localhost/api/community/channels/resolve/attachments${q}`, {
    method: "POST",
    headers,
  })
}
const botCtx = { params: { id: "resolve" } } as any

describe("POST /api/community/channels/[id]/attachments — bot arm (folds attachmentUpload)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockCreatePendingAttachment.mockResolvedValue({
      id: "att_1",
      filename: "hi.png",
      contentType: "image/png",
      size: 10,
      hasThumbnail: false,
    })
    mockHandleAttachmentUpload.mockResolvedValue({
      ok: true,
      r2Key: "channel/c1/uuid/hi.png",
      thumbnailR2Key: null,
      filename: "hi.png",
      contentType: "image/png",
      size: 10,
    })
  })

  it("401 without Authorization", async () => {
    const res = await POST(botReq("/studio#0042/general"), botCtx)
    expect(res.status).toBe(401)
  })

  it("400 when target query param is missing", async () => {
    const res = await POST(botReq(null, { Authorization: "Bearer crk_abc" }), botCtx)
    expect(res.status).toBe(400)
  })

  it("returns id + filename + contentType + size — no url, no r2Key", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([
      { id: "c1", serverId: "srv_1", parentChannelId: null },
    ])
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "srv_1", parentChannelId: null })

    const res = await POST(botReq("/studio#0042/general", { Authorization: "Bearer crk_abc" }), botCtx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      id: "att_1",
      filename: "hi.png",
      contentType: "image/png",
      size: 10,
      hasThumbnail: false,
    })
    // No leaked internals.
    expect(body.url).toBeUndefined()
    expect(body.r2Key).toBeUndefined()
    // Uploader tag threaded to the R2 primitive; the resolved id is used (not
    // the placeholder path id).
    expect(mockHandleAttachmentUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "channel",
      "c1",
      { uploader: "bot", uploaderUserId: "bot_1" },
    )
    expect(mockCreatePendingAttachment).toHaveBeenCalledWith({}, expect.objectContaining({
      uploaderId: "bot_1",
      targetId: "c1",
      r2Key: "channel/c1/uuid/hi.png",
    }))
  })

  it("persists thumbnail key and dimensions, returning hasThumbnail true", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([
      { id: "c1", serverId: "srv_1", parentChannelId: null },
    ])
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "srv_1", parentChannelId: null })
    mockHandleAttachmentUpload.mockResolvedValue({
      ok: true,
      r2Key: "channel/c1/uuid/hi.png",
      thumbnailR2Key: "channel/c1/uuid/hi.png.thumbnail.jpg",
      filename: "hi.png",
      contentType: "image/png",
      size: 10,
      width: 640,
      height: 480,
    })
    const response = await POST(botReq("/studio#0042/general", { Authorization: "Bearer crk_abc" }), botCtx)
    expect(await response.json()).toMatchObject({ hasThumbnail: true })
    expect(mockCreatePendingAttachment).toHaveBeenCalledWith({}, expect.objectContaining({
      thumbnailR2Key: "channel/c1/uuid/hi.png.thumbnail.jpg",
      width: 640,
      height: 480,
    }))
  })

  it("createPendingAttachment throws → 500 JSON envelope, R2 delete fired with r2Key", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([
      { id: "c1", serverId: "srv_1", parentChannelId: null },
    ])
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "srv_1", parentChannelId: null })
    mockCreatePendingAttachment.mockRejectedValueOnce(new Error("d1_transient"))

    const res = await POST(botReq("/studio#0042/general", { Authorization: "Bearer crk_abc" }), botCtx)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal error", code: "internal" })
    expect(mockR2Delete).toHaveBeenCalledWith("channel/c1/uuid/hi.png")
  })

  it("D1 failure after a thumbnail upload deletes both objects together", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([
      { id: "c1", serverId: "srv_1", parentChannelId: null },
    ])
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "srv_1", parentChannelId: null })
    mockHandleAttachmentUpload.mockResolvedValue({
      ok: true,
      r2Key: "original-key",
      thumbnailR2Key: "thumbnail-key",
      filename: "hi.png",
      contentType: "image/png",
      size: 10,
    })
    mockCreatePendingAttachment.mockRejectedValueOnce(new Error("d1"))
    expect((await POST(botReq("/studio#0042/general", { Authorization: "Bearer crk_abc" }), botCtx)).status).toBe(500)
    expect(mockR2Delete).toHaveBeenCalledWith(["original-key", "thumbnail-key"])
  })

  it("redacts object keys when compensation cleanup also fails", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([
      { id: "c1", serverId: "srv_1", parentChannelId: null },
    ])
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "srv_1", parentChannelId: null })
    mockHandleAttachmentUpload.mockResolvedValue({
      ok: true,
      r2Key: "secret-original-key",
      thumbnailR2Key: "secret-thumbnail-key",
      filename: "hi.png",
      contentType: "image/png",
      size: 10,
    })
    mockCreatePendingAttachment.mockRejectedValueOnce(new Error("d1"))
    mockR2Delete.mockRejectedValueOnce(new Error("cleanup failed"))

    const response = await POST(
      botReq("/studio#0042/general", { Authorization: "Bearer crk_abc" }),
      botCtx,
    )

    expect(response.status).toBe(500)
    const cleanupLog = mockLogError.mock.calls.find(
      ([event]) => event === "attachment_route_r2_cleanup_failed",
    )
    expect(cleanupLog?.[1]).toEqual(expect.objectContaining({ objectCount: 2 }))
    expect(JSON.stringify(cleanupLog)).not.toContain("secret-original-key")
    expect(JSON.stringify(cleanupLog)).not.toContain("secret-thumbnail-key")
  })

  it("pre-R2 throw (resolveTargetForMember errors) → 500 JSON, R2 delete NOT called", async () => {
    mockResolveServerByNameForMember.mockRejectedValueOnce(new Error("d1_outage"))
    const res = await POST(botReq("/studio#0042/general", { Authorization: "Bearer crk_abc" }), botCtx)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal error", code: "internal" })
    expect(mockR2Delete).not.toHaveBeenCalled()
  })

  it("propagates handler failure response verbatim", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([
      { id: "c1", serverId: "srv_1", parentChannelId: null },
    ])
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "srv_1", parentChannelId: null })
    mockHandleAttachmentUpload.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "file too large" }), { status: 413 }),
    })

    const res = await POST(botReq("/studio#0042/general", { Authorization: "Bearer crk_abc" }), botCtx)
    expect(res.status).toBe(413)
    expect(mockCreatePendingAttachment).not.toHaveBeenCalled()
  })
})

describe("POST /api/community/channels/[id]/attachments — human arm (re-homes channels/[id]/upload)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("delegates to runAttachmentUpload with the id-in-path ctx, returns its response unchanged", async () => {
    const helperResponse = new Response(JSON.stringify({ url: "/api/community/media/x", filename: "a.png" }), { status: 200 })
    mockRunAttachmentUpload.mockResolvedValueOnce(helperResponse)

    // Human session resolves — withAuth adopts { userId }.
    const { createAuth } = await import("@/lib/auth")
    ;(createAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      api: {
        getSession: vi.fn(async () => ({
          headers: new Headers(),
          response: { user: { id: "u1", email: "u@t.com", isBot: false, deletedAt: null } },
        })),
      },
    })

    const req = new NextRequest("http://localhost/api/community/channels/c1/attachments", { method: "POST" })
    const res = await POST(req, { params: { id: "c1" } } as any)
    expect(res).toBe(helperResponse)
    expect(mockRunAttachmentUpload).toHaveBeenCalledOnce()
    const args = mockRunAttachmentUpload.mock.calls[0]
    expect(args[0]).toBe(req)
    // The human arm forwards the id-in-path so the shared trunk resolves surface.
    expect(args[1]).toMatchObject({ userId: "u1", params: { id: "c1" } })
    // Bot-only pending-row insert never runs on the human arm.
    expect(mockCreatePendingAttachment).not.toHaveBeenCalled()
  })
})
