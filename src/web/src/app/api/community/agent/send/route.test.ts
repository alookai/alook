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
const mockCreateOrGetDM = vi.fn()
const mockIsBlocked = vi.fn()
const mockAreFriends = vi.fn()
const mockGetLatestSeqForScope = vi.fn()
const mockGetReadState = vi.fn()
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
      communityFriendship: {
        isBlocked: (...a: unknown[]) => mockIsBlocked(...a),
        areFriends: (...a: unknown[]) => mockAreFriends(...a),
      },
      communityServer: { resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a) },
      communityChannel: {
        resolveChannelByNameForMember: (...a: unknown[]) => mockResolveChannelByNameForMember(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
      },
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
        getDMBetween: (...a: unknown[]) => mockGetDMBetween(...a),
        createOrGetDM: (...a: unknown[]) => mockCreateOrGetDM(...a),
      },
      communityMessage: {
        ...actual.queries.communityMessage, // keep the real scopeKeyForTarget
      },
      communityAgentInbox: {
        getLatestSeqForScope: (...a: unknown[]) => mockGetLatestSeqForScope(...a),
        toAgentMessage: (...a: unknown[]) => mockToAgentMessage(...a),
      },
      communityReadState: { getReadState: (...a: unknown[]) => mockGetReadState(...a) },
    },
  }
})

const mockCreateCommunityMessage = vi.fn()
vi.mock("@/lib/community/message-handler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/community/message-handler")>()),
  createCommunityMessage: (...a: unknown[]) => mockCreateCommunityMessage(...a),
}))

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/send", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("POST /api/community/agent/send", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
    mockGetChannelForMember.mockResolvedValue({ id: "ch_1", serverId: "srv_1", parentChannelId: null })
    mockGetLatestSeqForScope.mockResolvedValue(0)
    mockGetReadState.mockResolvedValue(null)
    mockToAgentMessage.mockImplementation((_db: unknown, row: unknown) => Promise.resolve({ ...row as object, wireShaped: true }))
  })

  it("401 without Authorization", async () => {
    const res = await POST(req({ channel: "/studio/general", content: { text: "hi" } }))
    expect(res.status).toBe(401)
  })

  it("400 on a payload that fails schema validation (empty content text)", async () => {
    const res = await POST(
      req({ channel: "/studio/general", content: { text: "" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(400)
  })

  it("404 propagates ref-resolution errors (e.g. channel not found)", async () => {
    mockResolveChannelByNameForMember.mockResolvedValue([])
    const res = await POST(
      req({ channel: "/studio/missing", content: { text: "hi" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(404)
    expect(mockCreateCommunityMessage).not.toHaveBeenCalled()
  })

  it("returns { state: blocked, reason: unaligned } when the bot is behind the channel's latest seq and hasn't caught up", async () => {
    mockGetLatestSeqForScope.mockResolvedValue(10)
    mockGetReadState.mockResolvedValue({ lastReadSeq: 4 })
    const res = await POST(
      req({ channel: "/studio/general", content: { text: "hi" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ state: "blocked", reason: "unaligned", unreadCount: 6, latestSeq: 10 })
    expect(mockCreateCommunityMessage).not.toHaveBeenCalled()
  })

  it("propagates a CAS 409 conflict from createCommunityMessage as blocked/unaligned with a freshly re-fetched latestSeq", async () => {
    // Alignment gate passes (latestSeq=9, seen=9), but another agent's send
    // wins the race between the gate and the CAS claim — by the time this
    // request's claim runs, the counter has already moved to 10.
    mockGetLatestSeqForScope.mockResolvedValueOnce(9).mockResolvedValueOnce(10)
    mockGetReadState.mockResolvedValue({ lastReadSeq: 9 })
    mockCreateCommunityMessage.mockResolvedValue({ ok: false, status: 409, error: "seq_conflict" })
    const res = await POST(
      req({ channel: "/studio/general", content: { text: "hi" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ state: "blocked", reason: "unaligned", unreadCount: 1, latestSeq: 10 })
    expect(mockGetLatestSeqForScope).toHaveBeenCalledTimes(2)
  })

  it("happy path: createCommunityMessage is called with expectedSeq equal to the alignment-check's latestSeq (regression guard against drift)", async () => {
    mockGetLatestSeqForScope.mockResolvedValue(5)
    mockGetReadState.mockResolvedValue({ lastReadSeq: 5 })
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "m_1", seq: 6, content: "hi" } })
    const res = await POST(
      req({ channel: "/studio/general", content: { text: "hi" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(200)
    expect(mockCreateCommunityMessage).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSeq: 5 })
    )
  })

  it("an explicit seenUpToSeq overrides the bot's own tracked lastReadSeq for the alignment check", async () => {
    mockGetLatestSeqForScope.mockResolvedValue(10)
    mockGetReadState.mockResolvedValue({ lastReadSeq: 2 }) // would block if used
    mockGetChannelForMember.mockResolvedValue({ id: "ch_1", serverId: "srv_1", parentChannelId: null })
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "m_1", seq: 10 } })
    const res = await POST(
      req(
        { channel: "/studio/general", content: { text: "hi" }, seenUpToSeq: 10 },
        { Authorization: "Bearer crk_abc" }
      )
    )
    expect(res.status).toBe(200)
    expect((await res.json()).state).toBe("sent")
  })

  it("403 forbidden when resolution succeeds but channel membership gate fails", async () => {
    mockGetChannelForMember.mockResolvedValue(null)
    const res = await POST(
      req({ channel: "/studio/general", content: { text: "hi" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(403)
    expect(mockCreateCommunityMessage).not.toHaveBeenCalled()
  })

  it("200 { state: sent } happy path for a plain channel send", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "m_1", seq: 1, content: "hi" } })
    const res = await POST(
      req({ channel: "/studio/general", content: { text: "hi" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.state).toBe("sent")
    expect(body.message).toMatchObject({ id: "m_1", wireShaped: true })
    expect(mockCreateCommunityMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: "bot_1",
        target: { kind: "channel", channelId: "ch_1", serverId: "srv_1" },
        body: { content: "hi" },
        source: "cli",
      })
    )
  })

  it("reconstructs a thread MessageTarget (kind: thread) when the resolved channel has a parentChannelId", async () => {
    // A plain channel ref that happens to resolve to a thread's own channel
    // row exercises the SAME reconstruction branch as an actual `/#N`
    // thread ref, without needing to also mock the root-message/thread-row
    // lookups `resolveTargetForMember`'s thread-form parsing would trigger.
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "thread_1" }])
    mockGetChannelForMember.mockResolvedValue({ id: "thread_1", serverId: "srv_1", parentChannelId: "ch_parent" })
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "m_1", seq: 1, content: "hi" } })
    const res = await POST(
      req({ channel: "/studio/general", content: { text: "hi" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(200)
    expect(mockCreateCommunityMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "thread", channelId: "thread_1", parentChannelId: "ch_parent", serverId: "srv_1" },
      })
    )
  })

  it("propagates createCommunityMessage's own validation error (e.g. content too long) with its status", async () => {
    mockCreateCommunityMessage.mockResolvedValue({ ok: false, status: 400, error: "content is required" })
    const res = await POST(
      req({ channel: "/studio/general", content: { text: "hi" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "content is required" })
  })

  it("200 happy path for a DM send, auto-creating the DM row via createDmIfMissing", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "peer_1", discriminator: "0001" })
    mockGetUserInternal.mockImplementation((_db: unknown, id: string) =>
      Promise.resolve(id === "peer_1" ? { id: "peer_1", isBot: false, deletedAt: null } : { isBot: true, deletedAt: null })
    )
    mockIsBlocked.mockResolvedValue(false)
    mockCreateOrGetDM.mockResolvedValue({ id: "dm_new" })
    mockGetDM.mockResolvedValue({ id: "dm_new", user1Id: "bot_1", user2Id: "peer_1", lastMessageAt: null, createdAt: "t" })
    mockCreateCommunityMessage.mockResolvedValue({ ok: true, row: { id: "m_dm", seq: 1, content: "hey" } })
    const res = await POST(
      req({ channel: "/.dm/peer#0001", content: { text: "hey" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(200)
    expect(mockCreateCommunityMessage).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "dm", dmId: "dm_new", otherUserId: "peer_1" } })
    )
  })

  it("403 blocked propagates from guardDmOpen when trying to auto-create a DM with a blocking peer", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "peer_1", discriminator: "0001" })
    mockGetUserInternal.mockImplementation((_db: unknown, id: string) =>
      Promise.resolve(id === "peer_1" ? { id: "peer_1", isBot: false, deletedAt: null } : { isBot: true, deletedAt: null })
    )
    mockIsBlocked.mockResolvedValue(true)
    const res = await POST(
      req({ channel: "/.dm/peer#0001", content: { text: "hey" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(403)
    expect(mockCreateOrGetDM).not.toHaveBeenCalled()
    expect(mockCreateCommunityMessage).not.toHaveBeenCalled()
  })

  it("400 invalid DM handle when the channel segment has no #0042 tag", async () => {
    const res = await POST(
      req({ channel: "/.dm/peer_1", content: { text: "hey" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(400)
    expect(mockCreateCommunityMessage).not.toHaveBeenCalled()
  })

  it("sequential scenario: blocked/unaligned → pull+ack (simulated by an advancing lastReadSeq) → send succeeds → a new message arrives → send blocks again", async () => {
    // 1. Bot is behind: latestSeq=10, bot's own tracked lastReadSeq=4 → blocked.
    mockGetLatestSeqForScope.mockResolvedValueOnce(10)
    mockGetReadState.mockResolvedValueOnce({ lastReadSeq: 4 })
    const blocked1 = await POST(
      req({ channel: "/studio/general", content: { text: "catching up" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(blocked1.status).toBe(200)
    expect(await blocked1.json()).toEqual({ state: "blocked", reason: "unaligned", unreadCount: 6, latestSeq: 10 })
    expect(mockCreateCommunityMessage).not.toHaveBeenCalled()

    // 2. The agent pulls the backlog and acks up to seq 10 — modeled here as
    // the bot's tracked read state catching up to the channel's latest seq
    // (what a real inboxPull+ack round trip against
    // /api/community/agent/{inboxPull,ack} would produce).
    mockGetLatestSeqForScope.mockResolvedValueOnce(10)
    mockGetReadState.mockResolvedValueOnce({ lastReadSeq: 10 })
    mockCreateCommunityMessage.mockResolvedValueOnce({ ok: true, row: { id: "m_1", seq: 11, content: "caught up" } })
    const sent = await POST(
      req({ channel: "/studio/general", content: { text: "caught up" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(sent.status).toBe(200)
    expect((await sent.json()).state).toBe("sent")
    expect(mockCreateCommunityMessage).toHaveBeenCalledTimes(1)

    // 3. A new message (from someone else) lands in the channel, advancing
    // latestSeq past the bot's now-stale read state — the next send blocks
    // again without a fresh pull+ack.
    mockGetLatestSeqForScope.mockResolvedValueOnce(12)
    mockGetReadState.mockResolvedValueOnce({ lastReadSeq: 10 })
    const blocked2 = await POST(
      req({ channel: "/studio/general", content: { text: "still going" } }, { Authorization: "Bearer crk_abc" })
    )
    expect(blocked2.status).toBe(200)
    expect(await blocked2.json()).toEqual({ state: "blocked", reason: "unaligned", unreadCount: 2, latestSeq: 12 })
    // Still only the one successful send from step 2 — this blocked call
    // must not have reached createCommunityMessage.
    expect(mockCreateCommunityMessage).toHaveBeenCalledTimes(1)
  })
})
