import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockR2Get = vi.fn()
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: { DB: {}, COMMUNITY_MEDIA: { get: (...a: unknown[]) => mockR2Get(...a) } },
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
const mockGetAttachmentById = vi.fn()
const mockGetMessage = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetChannelType = vi.fn()
const mockGetDM = vi.fn()
const mockGetDMPeer = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityAttachment: {
        getAttachmentById: (...a: unknown[]) => mockGetAttachmentById(...a),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
      },
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        getChannelType: (...a: unknown[]) => mockGetChannelType(...a),
      },
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
        getDMPeer: (...a: unknown[]) => mockGetDMPeer(...a),
      },
      communityFriendship: { isBlocked: async () => false },
    },
  }
})

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/attachmentDownload", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("POST /api/community/agent/attachmentDownload", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
  })

  it("401 without Authorization", async () => {
    const res = await POST(req({ id: "x" }))
    expect(res.status).toBe(401)
  })

  it("404 when the id doesn't exist", async () => {
    mockGetAttachmentById.mockResolvedValue(null)
    const res = await POST(req({ id: "missing" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(404)
  })

  it("404 (not 403) when a pending row belongs to another bot — enumeration-safe", async () => {
    mockGetAttachmentById.mockResolvedValue({
      id: "att_1",
      messageId: null,
      uploaderId: "some_other_bot",
      r2Key: "channel/c1/uuid/a.png",
      filename: "a.png",
      contentType: "image/png",
      size: 10,
    })
    const res = await POST(req({ id: "att_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(404)
    // Body byte-identical to "genuine 404" case.
    const body = await res.json()
    expect(body).toEqual({ error: "attachment not found" })
    expect(mockR2Get).not.toHaveBeenCalled()
  })

  it("succeeds on a pending row owned by the requesting bot (round-trip verify)", async () => {
    mockGetAttachmentById.mockResolvedValue({
      id: "att_1",
      messageId: null,
      uploaderId: "bot_1",
      r2Key: "channel/c1/uuid/a.png",
      filename: "a.png",
      contentType: "image/png",
      size: 10,
    })
    mockR2Get.mockResolvedValue({
      body: new ReadableStream(),
      size: 10,
      httpMetadata: {},
      arrayBuffer: async () => new ArrayBuffer(10),
    })
    const res = await POST(req({ id: "att_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Content-Length")).toBe("10")
    // RFC 5987 header. ASCII filename → percent-encoded but unchanged.
    expect(res.headers.get("X-Alook-Filename")).toBe(encodeURIComponent("a.png"))
  })

  it("percent-encodes non-ASCII filenames per RFC 5987", async () => {
    mockGetAttachmentById.mockResolvedValue({
      id: "att_1",
      messageId: null,
      uploaderId: "bot_1",
      r2Key: "channel/c1/uuid/x.png",
      filename: "图表.png",
      contentType: "image/png",
      size: 5,
    })
    mockR2Get.mockResolvedValue({
      body: new ReadableStream(),
      size: 5,
      httpMetadata: {},
      arrayBuffer: async () => new ArrayBuffer(5),
    })
    const res = await POST(req({ id: "att_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const encoded = res.headers.get("X-Alook-Filename")
    expect(encoded).toBeTruthy()
    expect(decodeURIComponent(encoded!)).toBe("图表.png")
  })

  it("returns 502 when the row exists but R2 has no object (infra drift, not enumeration)", async () => {
    mockGetAttachmentById.mockResolvedValue({
      id: "att_1",
      messageId: null,
      uploaderId: "bot_1",
      r2Key: "channel/c1/uuid/a.png",
      filename: "a.png",
      contentType: "image/png",
      size: 10,
    })
    mockR2Get.mockResolvedValue(null)
    const res = await POST(req({ id: "att_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(502)
  })

  it("getAttachmentById throws → 500 JSON envelope (no binary body leak)", async () => {
    mockGetAttachmentById.mockRejectedValueOnce(new Error("d1_transient"))
    const res = await POST(req({ id: "att_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal error", code: "internal" })
  })

  it("COMMUNITY_MEDIA.get throws → 500 JSON envelope", async () => {
    mockGetAttachmentById.mockResolvedValue({
      id: "att_1",
      messageId: null,
      uploaderId: "bot_1",
      r2Key: "channel/c1/uuid/a.png",
      filename: "a.png",
      contentType: "image/png",
      size: 10,
    })
    mockR2Get.mockRejectedValueOnce(new Error("r2_boom"))
    const res = await POST(req({ id: "att_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal error", code: "internal" })
  })

  it("obj.arrayBuffer() throws (R2 stream mid-read) → 500 JSON envelope, NOT a truncated 200", async () => {
    mockGetAttachmentById.mockResolvedValue({
      id: "att_1",
      messageId: null,
      uploaderId: "bot_1",
      r2Key: "channel/c1/uuid/a.png",
      filename: "a.png",
      contentType: "image/png",
      size: 10,
    })
    mockR2Get.mockResolvedValue({
      body: new ReadableStream(),
      size: 10,
      httpMetadata: {},
      arrayBuffer: async () => {
        throw new Error("stream_error")
      },
    })
    const res = await POST(req({ id: "att_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal error", code: "internal" })
  })

  it("404 when a persisted row's channel-member gate fails — same shape as genuine 404", async () => {
    mockGetAttachmentById.mockResolvedValue({
      id: "att_1",
      messageId: "m_1",
      uploaderId: "bot_someone",
      r2Key: "channel/c1/uuid/a.png",
      filename: "a.png",
      contentType: "image/png",
      size: 10,
    })
    mockGetMessage.mockResolvedValue({ id: "m_1", channelId: "c1" })
    mockGetChannelType.mockResolvedValue("text")
    mockGetChannelForMember.mockResolvedValue(null) // not a member
    const res = await POST(req({ id: "att_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(404)
    expect(mockR2Get).not.toHaveBeenCalled()
  })
})
