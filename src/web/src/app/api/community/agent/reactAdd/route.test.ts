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
const mockGetDMPeer = vi.fn()
const mockIsBlocked = vi.fn()
const mockGetMessageByChannelAndSeq = vi.fn()
const mockAddReaction = vi.fn()
const mockFanOutToChannel = vi.fn(async () => undefined)
const mockFanOutToDM = vi.fn(async () => undefined)

vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
  fanOutToDM: (...a: unknown[]) => mockFanOutToDM(...a),
}))

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
        getDMPeer: (...a: unknown[]) => mockGetDMPeer(...a),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessageByChannelAndSeq: (...a: unknown[]) => mockGetMessageByChannelAndSeq(...a),
      },
      communityReaction: {
        ...actual.queries.communityReaction,
        addReaction: (...a: unknown[]) => mockAddReaction(...a),
      },
    },
  }
})

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/reactAdd", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("POST /api/community/agent/reactAdd", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
  })

  it("401 without Authorization", async () => {
    const res = await POST(req({ channel: "/studio/general", seq: 1, emoji: "👍" }))
    expect(res.status).toBe(401)
  })

  it("400 on invalid payload (missing emoji)", async () => {
    const res = await POST(req({ channel: "/studio/general", seq: 1 }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("400 rejects seq 0 (positive-seq schema)", async () => {
    const res = await POST(req({ channel: "/studio/general", seq: 0, emoji: "👍" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("400 rejects oversize emoji", async () => {
    const bigEmoji = "🎉".repeat(20)
    const res = await POST(req({ channel: "/studio/general", seq: 1, emoji: bigEmoji }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
    expect(mockAddReaction).not.toHaveBeenCalled()
  })

  it("404 propagates unresolvable ref", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([])
    const res = await POST(req({ channel: "/studio/general", seq: 3, emoji: "👍" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(404)
    expect(mockAddReaction).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("403 when the bot is not a channel member", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
    mockGetChannelForMember.mockResolvedValue(null)
    const res = await POST(req({ channel: "/studio/general", seq: 3, emoji: "👍" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(403)
    expect(mockAddReaction).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("404 when the channel exists but has no message at that seq", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
    mockGetChannelForMember.mockResolvedValue({ id: "ch_1", serverId: "srv_1", parentChannelId: null })
    mockGetMessageByChannelAndSeq.mockResolvedValue(null)
    const res = await POST(req({ channel: "/studio/general", seq: 99, emoji: "👍" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(404)
    expect(mockAddReaction).not.toHaveBeenCalled()
  })

  it("200 happy path — channel react: inserts, fans out to channel with REACTION_ADD, excluding the bot", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
    mockGetChannelForMember.mockResolvedValue({ id: "ch_1", serverId: "srv_1", parentChannelId: null })
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "m_1", seq: 3, content: "hi" })
    mockAddReaction.mockResolvedValue({ messageId: "m_1", userId: "bot_1", emoji: "👍" })

    const res = await POST(req({ channel: "/studio/general", seq: 3, emoji: "👍" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
    expect(mockAddReaction).toHaveBeenCalledWith(expect.anything(), { messageId: "m_1", userId: "bot_1", emoji: "👍" })
    expect(mockFanOutToChannel).toHaveBeenCalledTimes(1)
    const [channelId, event, opts] = mockFanOutToChannel.mock.calls[0]
    expect(channelId).toBe("ch_1")
    expect(event).toMatchObject({
      type: "community:reaction.add",
      messageId: "m_1",
      userId: "bot_1",
      emoji: "👍",
      channelId: "ch_1",
    })
    expect(opts).toEqual({ excludeUserId: "bot_1" })
    expect(mockFanOutToDM).not.toHaveBeenCalled()
  })

  it("200 happy path — DM react: fans out via fanOutToDM with channelId", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "peer_1", discriminator: "0001" })
    mockGetUserInternal.mockImplementation((_db: unknown, id: string) =>
      Promise.resolve(id === "peer_1" ? { id: "peer_1", isBot: false, deletedAt: null } : { isBot: true, deletedAt: null }),
    )
    mockGetDMBetween.mockResolvedValue({ id: "dm_1" })
    mockGetDM.mockResolvedValue({ id: "dm_1", lastMessageAt: null, createdAt: "t" })
    mockGetDMPeer.mockResolvedValue({ otherUserId: "peer_1" })
    mockIsBlocked.mockResolvedValue(false)
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "m_dm_1", seq: 2, content: "hey" })
    mockAddReaction.mockResolvedValue({ messageId: "m_dm_1", userId: "bot_1", emoji: "🙏" })

    const res = await POST(req({ channel: "/.dm/peer#0001", seq: 2, emoji: "🙏" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(mockFanOutToDM).toHaveBeenCalledTimes(1)
    const [dmId, event, opts] = mockFanOutToDM.mock.calls[0]
    expect(dmId).toBe("dm_1")
    expect(event).toMatchObject({
      type: "community:reaction.add",
      messageId: "m_dm_1",
      userId: "bot_1",
      emoji: "🙏",
      channelId: "dm_1",
    })
    expect(opts).toEqual({ excludeUserId: "bot_1" })
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("duplicate — addReaction throws unique-constraint → {ok:true, duplicate:true}, no fan-out", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
    mockGetChannelForMember.mockResolvedValue({ id: "ch_1", serverId: "srv_1", parentChannelId: null })
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "m_1", seq: 3, content: "hi" })
    // Match isUniqueConstraintError → matches SQLite UNIQUE constraint messages
    mockAddReaction.mockRejectedValue(new Error("D1_ERROR: UNIQUE constraint failed: community_reaction.message_id, community_reaction.user_id, community_reaction.emoji"))

    const res = await POST(req({ channel: "/studio/general", seq: 3, emoji: "👍" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, duplicate: true })
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
    expect(mockFanOutToDM).not.toHaveBeenCalled()
  })
})
