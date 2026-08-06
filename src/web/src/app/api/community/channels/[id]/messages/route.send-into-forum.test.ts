import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockCreateMessageWithThread = vi.fn()
const mockFindPendingAttachmentsForSender = vi.fn()
const mockResolveTargetForMember = vi.fn()
const mockRequireMessageSurfaceAccess = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityAttachment: {
        ...actual.queries.communityAttachment,
        findPendingAttachmentsForSender: (...a: unknown[]) => mockFindPendingAttachmentsForSender(...a),
      },
      communityAgentInbox: {
        ...actual.queries.communityAgentInbox,
        toAgentMessage: vi.fn(async (_db, row) => ({ id: row.id, content: row.content, seq: row.seq ?? 1 })),
      },
    },
  }
})

vi.mock("@/lib/community/resolve-ref", () => ({
  resolveTargetForMember: (...a: unknown[]) => mockResolveTargetForMember(...a),
}))

vi.mock("@/lib/community/permissions", () => ({
  requireMessageSurfaceAccess: (...a: unknown[]) => mockRequireMessageSurfaceAccess(...a),
}))

vi.mock("@/lib/community/create-channels", () => ({
  createMessageWithThread: (...a: unknown[]) => mockCreateMessageWithThread(...a),
}))

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}))

vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, actor: { kind: "bot", userId: "bot_1", ownerUserId: "owner_1", machineId: "m_1" }, params })
  },
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

const ctxResolve = { params: { id: "resolve" } } as any

function botReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/resolve/messages", {
    method: "POST",
    headers: { Authorization: "Bearer crk_abc", "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

// Dispatch mechanism: whether a bot send opens a thread is decided by the
// resolved target's kind ("forum") — the same channel.type resolveMessageTarget
// already derived — never by a body field's presence. These tests mock
// resolveMessageTarget's OWN dependencies (resolveTargetForMember +
// requireMessageSurfaceAccess) so the real resolveMessageTarget code runs and
// actually produces the "forum" kind from channel.type — the dispatch under
// test is target.kind, not a mocked target object.
describe("POST /api/community/channels/[id]/messages — send into a forum opens a thread (phase2 forum≡thread, folds createPost)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockForumTarget() {
    mockResolveTargetForMember.mockResolvedValue({ channelId: "c1" })
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "c1", serverId: "s1", type: "forum", parentChannelId: null } },
    })
  }

  it("routes through createMessageWithThread with content as the opener and replyContent as the thread's first reply", async () => {
    mockForumTarget()
    mockCreateMessageWithThread.mockResolvedValue({
      ok: true,
      message: { id: "msg_1", content: "My Post Title", seq: 5 },
      attachments: [],
      thread: { id: "th_1" },
      reply: { id: "msg_2", content: "the body", seq: 6 },
      replyAttachments: [],
    })

    const res = await POST(botReq({ channel: "/demo/forum1", content: { text: "My Post Title" }, replyContent: "the body" }), ctxResolve)

    expect(res.status).toBe(200)
    expect(mockCreateMessageWithThread).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: "bot_1",
        parentChannelId: "c1",
        serverId: "s1",
        body: { content: "My Post Title" },
        replyBody: { content: "the body" },
      }),
    )
    const json = await res.json()
    expect(json.state).toBe("sent")
    expect(json.threadId).toBe("th_1")
    expect(json.message.id).toBe("msg_1")
    expect(json.reply.id).toBe("msg_2")
  })

  it("targeting a forum WITHOUT replyContent → 400, never reaches createMessageWithThread", async () => {
    mockForumTarget()

    const res = await POST(botReq({ channel: "/demo/forum1", content: { text: "just a title" } }), ctxResolve)

    expect(res.status).toBe(400)
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("allows an attachment-only forum body while still rejecting a fully empty body", async () => {
    mockForumTarget()
    mockFindPendingAttachmentsForSender.mockResolvedValue([{ id: "att_1" }])
    mockCreateMessageWithThread.mockResolvedValue({
      ok: true,
      message: { id: "msg_1", content: "Title", seq: 5 },
      attachments: [],
      thread: { id: "th_1" },
      reply: { id: "msg_2", content: "", seq: 1 },
      replyAttachments: [{ id: "att_1", filename: "x.png", contentType: "image/png", size: 10 }],
    })

    const res = await POST(botReq({
      channel: "/demo/forum1",
      content: { text: "Title" },
      replyContent: "",
      attachments: ["att_1"],
    }), ctxResolve)

    expect(res.status).toBe(200)
    expect(mockCreateMessageWithThread).toHaveBeenCalledWith(
      expect.objectContaining({ replyBody: { content: "" }, replyAttachmentIds: ["att_1"] }),
    )
  })

  it("targeting a plain channel with replyContent set is IGNORED by this branch — falls through to the plain send path", async () => {
    mockResolveTargetForMember.mockResolvedValue({ channelId: "c1" })
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "c1", serverId: "s1", type: "text", parentChannelId: null } },
    })

    // The plain-send path downstream is intentionally unmocked here (full
    // coverage lives in route.test.ts) — this only proves dispatch never
    // entered the forum branch when the target isn't a forum, regardless of
    // replyContent being present.
    await expect(
      POST(botReq({ channel: "/demo/general", content: { text: "hi" }, replyContent: "unused" }), ctxResolve),
    ).rejects.toThrow()
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("targeting a thread (has parentChannelId) never opens a nested thread even with replyContent present", async () => {
    mockResolveTargetForMember.mockResolvedValue({ channelId: "th_1" })
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "th_1", serverId: "s1", type: "thread", parentChannelId: "c-parent" } },
    })

    await expect(
      POST(botReq({ channel: "/demo/forum1/#12", content: { text: "hi" }, replyContent: "unused" }), ctxResolve),
    ).rejects.toThrow()
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("targeting a DM never opens a thread even with replyContent present", async () => {
    mockResolveTargetForMember.mockResolvedValue({ channelId: "dm_1" })
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "dm", dm: { otherUserId: "u_peer" } },
    })

    await expect(
      POST(botReq({ channel: "/.dm/alice#0001", content: { text: "hi" }, replyContent: "unused" }), ctxResolve),
    ).rejects.toThrow()
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("validates pending attachments against the FORUM/channel id (not the not-yet-existing thread) before creating", async () => {
    mockForumTarget()
    mockFindPendingAttachmentsForSender.mockResolvedValue([{ id: "att_1" }])
    mockCreateMessageWithThread.mockResolvedValue({
      ok: true,
      message: { id: "msg_1", content: "Title", seq: 5 },
      attachments: [],
      thread: { id: "th_1" },
      reply: { id: "msg_2", content: "body", seq: 6 },
      replyAttachments: [{ id: "att_1", filename: "x.png", contentType: "image/png", size: 10 }],
    })

    await POST(botReq({ channel: "/demo/forum1", content: { text: "Title" }, replyContent: "body", attachments: ["att_1"] }), ctxResolve)

    expect(mockFindPendingAttachmentsForSender).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ids: ["att_1"], uploaderId: "bot_1", targetId: "c1" }),
    )
    expect(mockCreateMessageWithThread).toHaveBeenCalledWith(
      expect.objectContaining({ replyAttachmentIds: ["att_1"], attachmentIds: undefined }),
    )
  })

  it("a stolen/foreign pending attachment id (count mismatch) → 400, never reaches createMessageWithThread", async () => {
    mockForumTarget()
    mockFindPendingAttachmentsForSender.mockResolvedValue([])

    const res = await POST(botReq({ channel: "/demo/forum1", content: { text: "Title" }, replyContent: "body", attachments: ["stolen"] }), ctxResolve)

    expect(res.status).toBe(400)
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("does NOT run the alignment/hasUnread gate — a fresh thread-open is a new scope with no seq contention", async () => {
    mockForumTarget()
    mockCreateMessageWithThread.mockResolvedValue({
      ok: true,
      message: { id: "msg_1", content: "Title", seq: 1 },
      attachments: [],
      thread: { id: "th_1" },
      reply: { id: "msg_2", content: "body", seq: 2 },
      replyAttachments: [],
    })

    // No seenUpToSeq / read-state mocking at all — if the route ran the
    // alignment gate it would hit unmocked query functions and throw.
    const res = await POST(botReq({ channel: "/demo/forum1", content: { text: "Title" }, replyContent: "body" }), ctxResolve)

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.state).toBe("sent")
  })

  it("propagates a createMessageWithThread failure (e.g. thread-open collision) verbatim", async () => {
    mockForumTarget()
    mockCreateMessageWithThread.mockResolvedValue({ ok: false, status: 404, error: "thread not found" })

    const res = await POST(botReq({ channel: "/demo/forum1", content: { text: "Title" }, replyContent: "body" }), ctxResolve)

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "thread not found" })
  })
})
