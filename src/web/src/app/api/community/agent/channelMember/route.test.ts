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
const mockGetServer = vi.fn()
const mockResolveChannelByNameForMember = vi.fn()
const mockGetChannel = vi.fn()
const mockIsChannelPrivate = vi.fn()
const mockResolveChannelAccessContext = vi.fn()
const mockListThreadParticipantUserIds = vi.fn()
const mockResolveScopeMembers = vi.fn()
const mockGetMembersByUserIds = vi.fn()
const mockGetDMBetween = vi.fn()
const mockIsBlocked = vi.fn()
const mockGetMessageByChannelAndSeq = vi.fn()
const mockGetThreadChannelByParentMessage = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: {
        ...actual.queries.user,
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
        getUserByNameAndDiscriminator: (...a: unknown[]) => mockGetUserByNameAndDiscriminator(...a),
      },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityServer: {
        ...actual.queries.communityServer,
        resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a),
        getServer: (...a: unknown[]) => mockGetServer(...a),
      },
      communityChannel: {
        ...actual.queries.communityChannel,
        resolveChannelByNameForMember: (...a: unknown[]) => mockResolveChannelByNameForMember(...a),
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        isChannelPrivate: (...a: unknown[]) => mockIsChannelPrivate(...a),
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
        getThreadChannelByParentMessage: (...a: unknown[]) => mockGetThreadChannelByParentMessage(...a),
      },
      communityThread: {
        ...actual.queries.communityThread,
        listThreadParticipantUserIds: (...a: unknown[]) => mockListThreadParticipantUserIds(...a),
      },
      communityMembersResolver: {
        ...actual.queries.communityMembersResolver,
        resolveScopeMembers: (...a: unknown[]) => mockResolveScopeMembers(...a),
      },
      communityMember: {
        ...actual.queries.communityMember,
        getMembersByUserIds: (...a: unknown[]) => mockGetMembersByUserIds(...a),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessageByChannelAndSeq: (...a: unknown[]) => mockGetMessageByChannelAndSeq(...a),
      },
      communityDm: {
        ...actual.queries.communityDm,
        getDMBetween: (...a: unknown[]) => mockGetDMBetween(...a),
      },
      communityFriendship: {
        ...actual.queries.communityFriendship,
        isBlocked: (...a: unknown[]) => mockIsBlocked(...a),
      },
    },
  }
})

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/channelMember", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("POST /api/community/agent/channelMember", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    // Default: bot has channel access (server member, public channel).
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "ch_1", serverId: "srv_1", type: "text", parentChannelId: null, creatorId: "owner_1", categoryId: null },
      anchor: { id: "ch_1", type: "text", creatorId: "owner_1", categoryId: null },
      role: "member",
      isChannelMember: false,
      isCreator: false,
      isPrivate: false,
    })
  })

  it("401 without Authorization", async () => {
    const res = await POST(req({ channel: "/demo/general" }))
    expect(res.status).toBe(401)
  })

  it("400 on payload validation failure (missing channel)", async () => {
    const res = await POST(req({}, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("400 on a DM ref — channel-scoped only", async () => {
    // No DB mocks needed: DM refs are rejected up front, so an un-opened DM
    // (no peer, no DM row) still gets the specific channel-scoped 400 instead
    // of a misleading "dm not found" 404.
    const res = await POST(req({ channel: "/.dm/peer#0042" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("channel-scoped")
    expect(mockGetUserByNameAndDiscriminator).not.toHaveBeenCalled()
    expect(mockGetDMBetween).not.toHaveBeenCalled()
  })

  it("400 on a malformed ref", async () => {
    const res = await POST(req({ channel: "not-a-ref" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("public top-level channel → { visibility:'public', hint } with the server's actual name substituted", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "demo" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1", name: "general", type: "text", parentChannelId: null }])
    mockGetChannel.mockResolvedValue({ id: "ch_1", serverId: "srv_1", name: "general", type: "text" })
    mockGetServer.mockResolvedValue({ id: "srv_1", name: "demo" })
    mockIsChannelPrivate.mockResolvedValue(false)
    const res = await POST(req({ channel: "/demo/general" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      visibility: "public",
      hint: "This channel is public. Use `alook server member --server demo` to list who can see it.",
    })
    expect("members" in body).toBe(false)
  })

  it("private top-level channel → { visibility:'private', members } from resolveScopeMembers", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "demo" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1", name: "leadership", type: "text", parentChannelId: null }])
    mockGetChannel.mockResolvedValue({ id: "ch_1", serverId: "srv_1", name: "leadership", type: "text" })
    // Access context: bot is the creator (so it can see the private channel).
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "ch_1", serverId: "srv_1", type: "text", parentChannelId: null, creatorId: "bot_1", categoryId: "cat_1" },
      anchor: { id: "ch_1", type: "text", creatorId: "bot_1", categoryId: "cat_1" },
      role: "member",
      isChannelMember: false,
      isCreator: true,
      isPrivate: true,
    })
    mockIsChannelPrivate.mockResolvedValue(true)
    mockResolveScopeMembers.mockResolvedValue([
      { userId: "u_owner", role: "owner", source: "explicit" },
      { userId: "u_alice", role: "member", source: "explicit" },
    ])
    mockGetMembersByUserIds.mockResolvedValue([
      { userName: "gustavo", discriminator: "4821", role: "owner", nickname: "Gus" },
      { userName: "alice", discriminator: "0193", role: "member", nickname: null },
    ])
    const res = await POST(req({ channel: "/demo/leadership" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      visibility: "private",
      members: [
        { handle: "gustavo#4821", role: "owner", nickname: "Gus" },
        { handle: "alice#0193", role: "member" },
      ],
    })
  })

  it("thread ref → always private on the wire; roster is the thread-participant set", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "demo" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_parent", name: "general", type: "text", parentChannelId: null }])
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "msg_12" })
    mockGetThreadChannelByParentMessage.mockResolvedValue({ id: "th_1" })
    mockGetChannel.mockResolvedValue({ id: "th_1", serverId: "srv_1", name: "Thread", type: "thread", parentChannelId: "ch_parent" })
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "th_1", serverId: "srv_1", type: "thread", parentChannelId: "ch_parent", creatorId: "bot_1", categoryId: null },
      anchor: { id: "ch_parent", type: "text", creatorId: "owner_1", categoryId: null },
      role: "member",
      isChannelMember: false,
      isCreator: false,
      isPrivate: false,
    })
    mockListThreadParticipantUserIds.mockResolvedValue(["u_owner", "u_bot"])
    mockGetMembersByUserIds.mockResolvedValue([
      { userName: "gustavo", discriminator: "4821", role: "owner", nickname: null },
      { userName: "otter", discriminator: "5522", role: "member", nickname: null },
    ])

    const res = await POST(req({ channel: "/demo/general/#12" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.visibility).toBe("private")
    expect(body.members).toEqual([
      { handle: "gustavo#4821", role: "owner" },
      { handle: "otter#5522", role: "member" },
    ])
    expect(mockListThreadParticipantUserIds).toHaveBeenCalledWith(expect.anything(), "th_1")
  })

  it("forum post inside a PUBLIC forum → still private on the wire; roster is the PARTICIPANT set, not the whole server", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "demo" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "post_1", name: "bug-42", type: "forum_post", parentChannelId: "forum_1" }])
    // Access context: public forum (isPrivate=false) but the channel itself is a
    // `forum_post` — the route must NOT fall into the public/hint branch. A post
    // is the NOTIFY dimension: its roster is the participant set (like a thread),
    // never the whole server.
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "post_1", serverId: "srv_1", type: "forum_post", parentChannelId: "forum_1", creatorId: "bot_1", categoryId: null },
      anchor: { id: "forum_1", type: "forum", creatorId: "owner_1", categoryId: null },
      role: "member",
      isChannelMember: false,
      isCreator: true,
      isPrivate: false,
    })
    mockListThreadParticipantUserIds.mockResolvedValue(["u_bot", "u_alice"])
    mockGetMembersByUserIds.mockResolvedValue([
      { userName: "gus", discriminator: "4821", role: "member", nickname: null },
      { userName: "alice", discriminator: "0193", role: "member", nickname: null },
    ])

    const res = await POST(req({ channel: "/demo/bug-42" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.visibility).toBe("private")
    expect(body.members).toHaveLength(2)
    expect(mockListThreadParticipantUserIds).toHaveBeenCalledWith(expect.anything(), "post_1")
    expect(mockResolveScopeMembers).not.toHaveBeenCalledWith(expect.anything(), { scope: "post", scopeId: "post_1" })
  })
})
