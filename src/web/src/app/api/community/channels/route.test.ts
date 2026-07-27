import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockCreateChannelUnified = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@/lib/community/channel-service", () => ({
  createChannelUnified: (...a: unknown[]) => mockCreateChannelUnified(...a),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

const ctx = {} as any
function req(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

const OK = (channel: Record<string, unknown> = {}) => ({
  ok: true,
  created: true,
  channel: {
    id: "c_new",
    name: "chan",
    type: "text",
    parentChannelId: null,
    parentMessageId: null,
    categoryId: null,
    topic: null,
    position: 0,
    createdAt: "2026-07-12T00:00:00Z",
    lastMessageAt: null,
    messageCount: 0,
    parent: null,
    creator: null,
    authorId: null,
    authorAvatar: null,
    preview: null,
    tags: [],
    participants: [],
    ...channel,
  },
})

describe("POST /api/community/channels — validation + dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateChannelUnified.mockResolvedValue(OK())
  })

  it("creates a text channel and returns 201 { channel }", async () => {
    const res = await POST(req({ type: "text", serverId: "s1", name: "general" }), ctx)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.channel.id).toBe("c_new")
    expect(mockCreateChannelUnified).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "u1" },
      expect.objectContaining({ type: "text", serverId: "s1", name: "general" }),
    )
  })

  it("creates a forum channel", async () => {
    mockCreateChannelUnified.mockResolvedValue(OK({ type: "forum" }))
    const res = await POST(req({ type: "forum", serverId: "s1", name: "help" }), ctx)
    expect(res.status).toBe(201)
    expect((await res.json()).channel.type).toBe("forum")
  })

  it("creates a thread channel", async () => {
    mockCreateChannelUnified.mockResolvedValue(OK({ type: "thread", parentMessageId: "m1", parentChannelId: "c1" }))
    const res = await POST(req({ type: "thread", parentMessageId: "m1", name: "re: x" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCreateChannelUnified).toHaveBeenCalledWith(
      expect.anything(),
      { userId: "u1" },
      { type: "thread", parentMessageId: "m1", name: "re: x" },
    )
  })

  it("creates a post channel and fills the card fields (R17 envelope)", async () => {
    mockCreateChannelUnified.mockResolvedValue(
      OK({
        type: "post",
        parentChannelId: "forum1",
        messageCount: 0,
        parent: { authorName: "Alice", text: "hi" },
        creator: { id: "u1", name: "Alice", avatar: "A" },
        authorId: "u1",
        authorAvatar: "A",
        preview: "hi",
        participants: [{ id: "u1", name: "Alice", avatar: "A" }],
      }),
    )
    const res = await POST(req({ type: "post", parentChannelId: "forum1", name: "title", content: "hi" }), ctx)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.channel.type).toBe("post")
    expect(body.channel.creator.id).toBe("u1")
    expect(body.channel.participants).toHaveLength(1)
  })

  // R9 — content optional / pure-attachment posts.
  it("accepts a pure-attachment post (empty content, object attachments) — R9", async () => {
    mockCreateChannelUnified.mockResolvedValue(OK({ type: "post" }))
    const res = await POST(
      req({
        type: "post",
        parentChannelId: "forum1",
        name: "img",
        content: "",
        attachments: [
          { url: "/api/community/media/x.png", filename: "x.png", contentType: "image/png", size: 10, width: 1, height: 1 },
        ],
      }),
      ctx,
    )
    expect(res.status).toBe(201)
    // The object attachments are forwarded through to the service (not dropped
    // by the schema's string[] typing).
    const passed = mockCreateChannelUnified.mock.calls[0]?.[2] as { attachments?: unknown[] }
    expect(passed.attachments).toHaveLength(1)
    expect((passed.attachments?.[0] as { url: string }).url).toBe("/api/community/media/x.png")
  })

  it("rejects a post with neither content nor attachments (post is empty) — R9", async () => {
    const res = await POST(req({ type: "post", parentChannelId: "forum1", name: "empty", content: "   " }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("post is empty")
    expect(mockCreateChannelUnified).not.toHaveBeenCalled()
  })

  // R13/R14 — field names + mentionType.
  it("forwards mentionType so @everyone can roster-broadcast (R14)", async () => {
    mockCreateChannelUnified.mockResolvedValue(OK({ type: "post" }))
    await POST(
      req({ type: "post", parentChannelId: "forum1", name: "heads", content: "@everyone hi", mentionType: "everyone" }),
      ctx,
    )
    const passed = mockCreateChannelUnified.mock.calls[0]?.[2] as { mentionType?: string }
    expect(passed.mentionType).toBe("everyone")
  })

  it("rejects text missing name", async () => {
    const res = await POST(req({ type: "text", serverId: "s1" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannelUnified).not.toHaveBeenCalled()
  })

  it("rejects post missing parentChannelId", async () => {
    const res = await POST(req({ type: "post", name: "x", content: "hi" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannelUnified).not.toHaveBeenCalled()
  })

  it("rejects thread missing name", async () => {
    const res = await POST(req({ type: "thread", parentMessageId: "m1" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannelUnified).not.toHaveBeenCalled()
  })

  it("rejects an illegal type value", async () => {
    const res = await POST(req({ type: "dm", serverId: "s1", name: "x" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannelUnified).not.toHaveBeenCalled()
  })

  it("rejects invalid JSON body", async () => {
    const bad = new NextRequest("http://localhost/api/community/channels", { method: "POST", body: "{" })
    const res = await POST(bad, ctx)
    expect(res.status).toBe(400)
  })

  it("propagates the service status/error (e.g. 403 admin-only)", async () => {
    mockCreateChannelUnified.mockResolvedValue({ ok: false, status: 403, error: "admin permission required" })
    const res = await POST(req({ type: "text", serverId: "s1", name: "general" }), ctx)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("admin permission required")
  })

  it("propagates a 409 name conflict", async () => {
    mockCreateChannelUnified.mockResolvedValue({ ok: false, status: 409, error: "a channel with this name already exists" })
    const res = await POST(req({ type: "text", serverId: "s1", name: "general" }), ctx)
    expect(res.status).toBe(409)
  })

  it("returns 409 when the thread already exists (created:false dedupe hit)", async () => {
    mockCreateChannelUnified.mockResolvedValue({
      ...OK({ type: "thread", parentMessageId: "m1", parentChannelId: "c1" }),
      created: false,
    })
    const res = await POST(req({ type: "thread", parentMessageId: "m1", name: "dup" }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("message already has a thread")
  })
})
