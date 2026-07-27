import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockR2Get = vi.fn()
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: { DB: {}, COMMUNITY_MEDIA: { get: (...a: unknown[]) => mockR2Get(...a) } },
  })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

// No session → withCommunityActor delegates to withAuth, whose session lookup
// returns null ⇒ 401. (Without this mock the real createAuth throws → a 503.)
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({ api: { getSession: vi.fn(async () => null) } })),
}))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockGetAttachmentById = vi.fn()
const mockGetMessage = vi.fn()
const mockGetChannelForMember = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityAttachment: { getAttachmentById: (...a: unknown[]) => mockGetAttachmentById(...a) },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
      },
      communityChannel: { getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a) },
    },
  }
})

import { GET } from "./route"

function req(id: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/community/attachments/${id}/download`, { headers })
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })
// A valid bot crk_ so withCommunityActor resolves userId = bot_1.
const BOT = { Authorization: "Bearer crk_abc" }

describe("GET /api/community/attachments/[id]/download", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
  })

  it("401 without any credential", async () => {
    const res = await GET(req("a1"), params("a1") as any)
    expect(res.status).toBe(401)
  })

  it("404 when the attachment id doesn't exist", async () => {
    mockGetAttachmentById.mockResolvedValue(null)
    const res = await GET(req("a_ghost", BOT), params("a_ghost") as any)
    expect(res.status).toBe(404)
  })

  it("404 (enumeration-safe) on a pending attachment uploaded by someone else", async () => {
    mockGetAttachmentById.mockResolvedValue({ id: "a1", messageId: null, uploaderId: "other", r2Key: "k" })
    const res = await GET(req("a1", BOT), params("a1") as any)
    expect(res.status).toBe(404)
    expect(mockR2Get).not.toHaveBeenCalled()
  })

  it("serves a pending attachment to its own uploader", async () => {
    mockGetAttachmentById.mockResolvedValue({ id: "a1", messageId: null, uploaderId: "bot_1", r2Key: "k", filename: "f.png", contentType: "image/png", size: 3 })
    mockR2Get.mockResolvedValue({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, httpMetadata: { contentType: "image/png" }, size: 3 })
    const res = await GET(req("a1", BOT), params("a1") as any)
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Alook-Filename")).toBe("f.png")
    expect(res.headers.get("Content-Type")).toBe("image/png")
  })

  it("404 on a persisted attachment whose channel the caller can't access", async () => {
    mockGetAttachmentById.mockResolvedValue({ id: "a1", messageId: "m1", r2Key: "k" })
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "c1", dmConversationId: null })
    mockGetChannelForMember.mockResolvedValue(null) // non-member
    const res = await GET(req("a1", BOT), params("a1") as any)
    expect(res.status).toBe(404)
    expect(mockR2Get).not.toHaveBeenCalled()
  })

  it("502 when the row exists but R2 has drifted", async () => {
    mockGetAttachmentById.mockResolvedValue({ id: "a1", messageId: "m1", r2Key: "k", filename: "f", contentType: "text/plain", size: 1 })
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "c1", dmConversationId: null })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", role: "member" })
    mockR2Get.mockResolvedValue(null)
    const res = await GET(req("a1", BOT), params("a1") as any)
    expect(res.status).toBe(502)
  })
})
