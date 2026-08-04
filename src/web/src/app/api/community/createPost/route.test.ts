import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
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
const mockGetServer = vi.fn()
const mockFindPendingAttachmentsForBot = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityServer: {
        resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a),
        getServer: (...a: unknown[]) => mockGetServer(...a),
      },
      communityChannel: {
        resolveChannelByNameForMember: (...a: unknown[]) => mockResolveChannelByNameForMember(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
      },
      communityAttachment: {
        findPendingAttachmentsForBot: (...a: unknown[]) => mockFindPendingAttachmentsForBot(...a),
      },
    },
  }
})

const mockCreateForumPost = vi.fn()
vi.mock("@/lib/community/create-forum-post", () => ({
  createForumPost: (...a: unknown[]) => mockCreateForumPost(...a),
}))

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/createPost", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const AUTH = { Authorization: "Bearer crk_abc" }

describe("POST /api/community/createPost", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    // Forum ref resolves to a forum channel the bot can access.
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "forum_1" }])
    mockGetChannelForMember.mockResolvedValue({ id: "forum_1", serverId: "srv_1", type: "forum", name: "ideas", parentChannelId: null })
    mockGetServer.mockResolvedValue({ id: "srv_1", name: "studio" })
    mockFindPendingAttachmentsForBot.mockResolvedValue([])
    mockCreateForumPost.mockResolvedValue({
      ok: true,
      postChannel: { id: "post_1", name: "my-post", createdAt: "2026-08-04T00:00:00.000Z" },
      messageRow: { id: "m_1", seq: 1 },
      attachments: [],
    })
  })

  it("401 without Authorization (human path, no session)", async () => {
    const res = await POST(req({ forum: "/studio/ideas", title: "My Post", content: { text: "hi" } }))
    expect(res.status).toBe(401)
  })

  it("400 on schema failure — empty title", async () => {
    const res = await POST(req({ forum: "/studio/ideas", title: "", content: { text: "hi" } }, AUTH))
    expect(res.status).toBe(400)
  })

  it("400 on opener empty — no text and no attachments (attachment-only IS allowed, empty is not)", async () => {
    const res = await POST(req({ forum: "/studio/ideas", title: "My Post", content: { text: "" } }, AUTH))
    expect(res.status).toBe(400)
  })

  it("201 + canonical /server/forum/<slug> ref on success (round-trippable as next --target)", async () => {
    const res = await POST(req({ forum: "/studio/ideas", title: "My Post", content: { text: "hello" } }, AUTH))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.post.ref).toBe("/studio/ideas/my-post")
    expect(body.post.name).toBe("my-post")
  })

  it("authz symmetry: a bot that is NOT a member of the (private) forum → 403, same as a human", async () => {
    // requireChannelMember → getChannelForMember returns null when the bot can't
    // see the forum (private, not a member) → 403 "forbidden". This proves the
    // create gate runs requireChannelMember, not a requireBot shortcut.
    mockGetChannelForMember.mockResolvedValue(null)
    const res = await POST(req({ forum: "/studio/ideas", title: "My Post", content: { text: "hi" } }, AUTH))
    expect(res.status).toBe(403)
    expect(mockCreateForumPost).not.toHaveBeenCalled()
  })

  it("400 when the resolved target is not a forum (e.g. a text channel)", async () => {
    mockGetChannelForMember.mockResolvedValue({ id: "forum_1", serverId: "srv_1", type: "text", name: "general", parentChannelId: null })
    const res = await POST(req({ forum: "/studio/general", title: "My Post", content: { text: "hi" } }, AUTH))
    expect(res.status).toBe(400)
    expect(mockCreateForumPost).not.toHaveBeenCalled()
  })

  it("(5b) attachment widen: a pending id NOT bound to this forum → 400, no cross-forum reuse", async () => {
    // Bound to forum A but this create targets forum_1 → findPendingAttachmentsForBot
    // (queried with targetId=forum_1) returns fewer rows than requested → 400.
    mockFindPendingAttachmentsForBot.mockResolvedValue([]) // 0 found for 1 requested
    const res = await POST(
      req({ forum: "/studio/ideas", title: "My Post", content: { text: "" }, attachments: ["att_from_other_forum"] }, AUTH),
    )
    expect(res.status).toBe(400)
    expect(mockCreateForumPost).not.toHaveBeenCalled()
    // Validated against THIS forum's id (the widen: bind-to-forum).
    expect(mockFindPendingAttachmentsForBot).toHaveBeenCalledWith(expect.anything(), {
      ids: ["att_from_other_forum"],
      uploaderId: "bot_1",
      targetId: "forum_1",
    })
  })

  it("attachment-only post (no text, valid forum-bound attachment) → succeeds", async () => {
    mockFindPendingAttachmentsForBot.mockResolvedValue([{ id: "att_1" }])
    const res = await POST(
      req({ forum: "/studio/ideas", title: "My Post", content: { text: "" }, attachments: ["att_1"] }, AUTH),
    )
    expect(res.status).toBe(201)
    expect(mockCreateForumPost).toHaveBeenCalled()
  })

  it("surfaces createForumPost's structured error (e.g. slug allocation 409)", async () => {
    mockCreateForumPost.mockResolvedValue({ ok: false, status: 409, error: "could not allocate a unique name after repeated collisions" })
    const res = await POST(req({ forum: "/studio/ideas", title: "My Post", content: { text: "hi" } }, AUTH))
    expect(res.status).toBe(409)
  })
})
