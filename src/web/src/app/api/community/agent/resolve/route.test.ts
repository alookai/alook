import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetUserByNameAndDiscriminator = vi.fn()
const mockGetBotBinding = vi.fn()
const mockResolveServerByNameForMember = vi.fn()
const mockResolveChannelByNameForMember = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetDM = vi.fn()
const mockGetDMBetween = vi.fn()
const mockIsBlocked = vi.fn()
const mockGetMessageByChannelAndSeq = vi.fn()
const mockToAgentMessage = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
        getUserByNameAndDiscriminator: (...a: unknown[]) => mockGetUserByNameAndDiscriminator(...a),
      },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityFriendship: { isBlocked: (...a: unknown[]) => mockIsBlocked(...a) },
      communityServer: { resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a) },
      communityChannel: {
        resolveChannelByNameForMember: (...a: unknown[]) => mockResolveChannelByNameForMember(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
      },
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
        getDMBetween: (...a: unknown[]) => mockGetDMBetween(...a),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessageByChannelAndSeq: (...a: unknown[]) => mockGetMessageByChannelAndSeq(...a),
      },
      communityAgentInbox: { toAgentMessage: (...a: unknown[]) => mockToAgentMessage(...a) },
    },
  }
})

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("POST /api/community/agent/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockToAgentMessage.mockImplementation((_db: unknown, row: unknown) => Promise.resolve({ ...row as object, wireShaped: true }))
  })

  it("401 without Authorization", async () => {
    const res = await POST(req({ channel: "/studio/general", seq: 1 }))
    expect(res.status).toBe(401)
  })

  it("400 on a payload that fails schema validation", async () => {
    const res = await POST(req({ channel: "", seq: 1 }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("404 rejects seq 0 (legacy sentinel) before even resolving the channel", async () => {
    const res = await POST(req({ channel: "/studio/general", seq: 0 }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(404)
    expect(mockResolveServerByNameForMember).not.toHaveBeenCalled()
  })

  it("404 propagates the ref-resolution error (channel not found)", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([])
    const res = await POST(req({ channel: "/studio/general", seq: 3 }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "server not found: studio" })
  })

  it("403 forbidden when the bot resolves the channel but isn't actually a member", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
    mockGetChannelForMember.mockResolvedValue(null)
    const res = await POST(req({ channel: "/studio/general", seq: 3 }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(403)
  })

  it("404 when the channel exists but has no message at that seq", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
    mockGetChannelForMember.mockResolvedValue({ id: "ch_1", serverId: "srv_1", parentChannelId: null })
    mockGetMessageByChannelAndSeq.mockResolvedValue(null)
    const res = await POST(req({ channel: "/studio/general", seq: 99 }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/no message with seq #99/)
  })

  it("200 happy path: resolves the channel ref, fetches by seq, and wire-shapes via toAgentMessage", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
    mockGetChannelForMember.mockResolvedValue({ id: "ch_1", serverId: "srv_1", parentChannelId: null })
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "m_1", seq: 3, content: "hi" })
    const res = await POST(req({ channel: "/studio/general", seq: 3 }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.message).toMatchObject({ id: "m_1", seq: 3, wireShaped: true })
    expect(mockGetMessageByChannelAndSeq).toHaveBeenCalledWith(expect.anything(), { channelId: "ch_1" }, 3)
  })

  it("200 happy path over a DM ref, gated by requireDMParticipant", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "peer_1", discriminator: "0001" })
    mockGetUserInternal.mockImplementation((_db: unknown, id: string) =>
      Promise.resolve(id === "peer_1" ? { id: "peer_1", isBot: false, deletedAt: null } : { isBot: true, deletedAt: null })
    )
    // resolveTargetForMember (no createDmIfMissing) needs an existing DM row.
    mockGetDMBetween.mockResolvedValue({ id: "dm_1" })
    mockGetDM.mockResolvedValue({ id: "dm_1", user1Id: "bot_1", user2Id: "peer_1", lastMessageAt: null, createdAt: "t" })
    mockIsBlocked.mockResolvedValue(false)
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "m_dm_1", seq: 2, content: "hey" })
    const res = await POST(req({ channel: "/.dm/peer#0001", seq: 2 }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(mockGetMessageByChannelAndSeq).toHaveBeenCalledWith(expect.anything(), { dmConversationId: "dm_1" }, 2)
  })

  it("400 invalid DM handle when the channel segment has no #0042 tag", async () => {
    const res = await POST(req({ channel: "/.dm/peer_1", seq: 2 }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })
})
