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
// yields the human-path 401 ("unauthorized") — the real unified-actor contract —
// instead of a 503 from unmocked session validation.
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

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
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
vi.mock("@/lib/community/upload", () => ({
  handleAttachmentUpload: (...a: unknown[]) => mockHandleAttachmentUpload(...a),
}))

import { POST } from "./route"

function req(target: string | null, headers: Record<string, string> = {}): NextRequest {
  const q = target !== null ? `?target=${encodeURIComponent(target)}` : ""
  return new NextRequest(`http://localhost/api/community/agent/attachmentUpload${q}`, {
    method: "POST",
    headers,
  })
}

describe("POST /api/community/agent/attachmentUpload", () => {
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
    })
    mockHandleAttachmentUpload.mockResolvedValue({
      ok: true,
      r2Key: "channel/c1/uuid/hi.png",
      filename: "hi.png",
      contentType: "image/png",
      size: 10,
    })
  })

  it("401 without Authorization", async () => {
    const res = await POST(req("/studio/general"))
    expect(res.status).toBe(401)
  })

  it("400 when target query param is missing", async () => {
    const res = await POST(req(null, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("returns id + filename + contentType + size — no url, no r2Key", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([
      { id: "c1", serverId: "srv_1", parentChannelId: null },
    ])
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "srv_1", parentChannelId: null })

    const res = await POST(req("/studio/general", { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      id: "att_1",
      filename: "hi.png",
      contentType: "image/png",
      size: 10,
    })
    // No leaked internals.
    expect(body.url).toBeUndefined()
    expect(body.r2Key).toBeUndefined()
    // Uploader tag is threaded to the R2 primitive.
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

  it("createPendingAttachment throws → 500 JSON envelope, R2 delete fired with r2Key", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([
      { id: "c1", serverId: "srv_1", parentChannelId: null },
    ])
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "srv_1", parentChannelId: null })
    mockCreatePendingAttachment.mockRejectedValueOnce(new Error("d1_transient"))

    const res = await POST(req("/studio/general", { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: "internal error", code: "internal" })
    expect(mockR2Delete).toHaveBeenCalledWith("channel/c1/uuid/hi.png")
  })

  it("createPendingAttachment throws AND R2 delete also throws → still 500 JSON, no rethrow", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([
      { id: "c1", serverId: "srv_1", parentChannelId: null },
    ])
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "srv_1", parentChannelId: null })
    mockCreatePendingAttachment.mockRejectedValueOnce(new Error("d1_transient"))
    mockR2Delete.mockRejectedValueOnce(new Error("r2_boom"))

    const res = await POST(req("/studio/general", { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal error", code: "internal" })
  })

  it("pre-R2 throw (resolveTargetForMember errors) → 500 JSON, R2 delete NOT called", async () => {
    mockResolveServerByNameForMember.mockRejectedValueOnce(new Error("d1_outage"))

    const res = await POST(req("/studio/general", { Authorization: "Bearer crk_abc" }))
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

    const res = await POST(req("/studio/general", { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(413)
    expect(mockCreatePendingAttachment).not.toHaveBeenCalled()
  })
})
