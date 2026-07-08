import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindActiveCredential = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockGetChannel = vi.fn()
const mockGetMember = vi.fn()
const mockGetDM = vi.fn()
const mockIsBlocked = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveCredentialByBearer: (...a: unknown[]) => mockFindActiveCredential(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityChannel: { getChannel: (...a: unknown[]) => mockGetChannel(...a) },
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityDm: { getDM: (...a: unknown[]) => mockGetDM(...a) },
      communityFriendship: { isBlocked: (...a: unknown[]) => mockIsBlocked(...a) },
    },
  }
})

// `createCommunityMessage`'s own audit-emission logic is unit-tested in
// `message-handler.test.ts` (plan §10) — this route test's only job is
// verifying THIS route calls it with `source: "daemon-http"` and does NOT
// also fire its own `logAudit` (the duplicate-audit regression this route
// used to have before the relocation, see route.ts's inline comments).
const mockCreateCommunityMessage = vi.fn()
vi.mock("@/lib/community/message-handler", () => ({
  createCommunityMessage: (...a: unknown[]) => mockCreateCommunityMessage(...a),
}))

const mockLogAudit = vi.fn()
vi.mock("@/lib/community/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/audit")>("@/lib/community/audit")
  return { ...actual, logAudit: (...a: unknown[]) => mockLogAudit(...a) }
})

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/daemon/bots/bot_1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function ctxParams() {
  return { params: Promise.resolve({ botId: "bot_1" }) }
}

describe("POST /api/community/daemon/bots/[botId]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveCredential.mockResolvedValue({ credentialId: "cmk_1", userId: "u_owner", machineId: "cm_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, ownerUserId: "u_owner", deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "cm_1", runtime: "claude" })
  })

  it("channel send: calls createCommunityMessage with source 'daemon-http' and never calls logAudit itself", async () => {
    mockGetChannel.mockResolvedValue({ id: "ch_1", serverId: "srv_1" })
    mockGetMember.mockResolvedValue({ userId: "bot_1" })
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "m_1" } })

    const res = await POST(
      req({ target: "channel", targetId: "ch_1", content: "hi" }, { Authorization: "Bearer cmk_1" }),
      ctxParams()
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messageId: "m_1" })
    expect(mockCreateCommunityMessage).toHaveBeenCalledTimes(1)
    expect(mockCreateCommunityMessage).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: "bot_1", source: "daemon-http" })
    )
    // The route itself must never call logAudit — that's exclusively
    // `createCommunityMessage`'s job now (which is mocked away here).
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("DM send: calls createCommunityMessage with source 'daemon-http' and never calls logAudit itself", async () => {
    mockGetDM.mockResolvedValue({ id: "dm_1", user1Id: "bot_1", user2Id: "peer_1" })
    mockIsBlocked.mockResolvedValue(false)
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "m_dm_1" } })

    const res = await POST(
      req({ target: "dm", targetId: "dm_1", content: "hey" }, { Authorization: "Bearer cmk_1" }),
      ctxParams()
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messageId: "m_dm_1" })
    expect(mockCreateCommunityMessage).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: "bot_1", source: "daemon-http" })
    )
    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("403 bot_not_a_member when the bot isn't in the target channel's server — no message created", async () => {
    mockGetChannel.mockResolvedValue({ id: "ch_1", serverId: "srv_1" })
    mockGetMember.mockResolvedValue(null)
    const res = await POST(
      req({ target: "channel", targetId: "ch_1", content: "hi" }, { Authorization: "Bearer cmk_1" }),
      ctxParams()
    )
    expect(res.status).toBe(403)
    expect(mockCreateCommunityMessage).not.toHaveBeenCalled()
  })
})
