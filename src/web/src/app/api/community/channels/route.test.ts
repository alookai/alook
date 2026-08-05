import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockCreateServerChannel = vi.fn()
const mockCreateDm = vi.fn()
const mockCreateThread = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

// Human arm: withAuth delegates to the session; the door's bot arm is a separate
// carve-out commit (bot may create thread/DM only, channel → 403), not wired here.
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any) =>
    handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com" }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

vi.mock("@/lib/community/create-channels", () => ({
  createServerChannelForUser: (...a: unknown[]) => mockCreateServerChannel(...a),
  createDmForUser: (...a: unknown[]) => mockCreateDm(...a),
  createThreadForUser: (...a: unknown[]) => mockCreateThread(...a),
}))

import { POST } from "./route"

function req(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("POST /api/community/channels (create door — human arm)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateServerChannel.mockResolvedValue({ ok: true, value: { id: "c-new", name: "general", type: "text" } })
    mockCreateDm.mockResolvedValue({ ok: true, value: { id: "dm-1" } })
    mockCreateThread.mockResolvedValue({ ok: true, value: { id: "t-1", parentMessageId: "msg-p" } })
  })

  it("dispatches type=text to the server-channel core, 201 {channel}", async () => {
    const res = await POST(req({ type: "text", serverId: "s1", name: "general" }))
    expect(res.status).toBe(201)
    expect(mockCreateServerChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverId: "s1", actorUserId: "u1", name: "general", type: "text" }),
    )
    const body = await res.json()
    expect(body.channel.id).toBe("c-new")
    expect(mockCreateDm).not.toHaveBeenCalled()
    expect(mockCreateThread).not.toHaveBeenCalled()
  })

  it("dispatches type=forum to the server-channel core", async () => {
    const res = await POST(req({ type: "forum", serverId: "s1", name: "ideas" }))
    expect(res.status).toBe(201)
    expect(mockCreateServerChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "forum" }),
    )
  })

  it("dispatches undefined type to the server-channel core (defaults to text)", async () => {
    const res = await POST(req({ serverId: "s1", name: "general" }))
    expect(res.status).toBe(201)
    expect(mockCreateServerChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ serverId: "s1", type: undefined }),
    )
  })

  it("400s a text/forum create with no serverId (before touching the core)", async () => {
    const res = await POST(req({ type: "text", name: "general" }))
    expect(res.status).toBe(400)
    expect(mockCreateServerChannel).not.toHaveBeenCalled()
  })

  it("dispatches type=dm to the DM core, 201 {conversation}", async () => {
    const res = await POST(req({ type: "dm", userId: "u2" }))
    expect(res.status).toBe(201)
    expect(mockCreateDm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorUserId: "u1", peerUserId: "u2" }),
    )
    const body = await res.json()
    expect(body.conversation.id).toBe("dm-1")
  })

  it("dispatches type=thread to the thread core, 201 with the child channel", async () => {
    const res = await POST(req({ type: "thread", messageId: "msg-p", name: "side chat" }))
    expect(res.status).toBe(201)
    expect(mockCreateThread).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: "msg-p", actorUserId: "u1", name: "side chat" }),
    )
    const body = await res.json()
    expect(body.id).toBe("t-1")
  })

  it("400s a thread create with no messageId (before touching the core)", async () => {
    const res = await POST(req({ type: "thread", name: "x" }))
    expect(res.status).toBe(400)
    expect(mockCreateThread).not.toHaveBeenCalled()
  })

  it("400s an unknown type", async () => {
    const res = await POST(req({ type: "forum_post", serverId: "s1", name: "x" }))
    expect(res.status).toBe(400)
    expect(mockCreateServerChannel).not.toHaveBeenCalled()
    expect(mockCreateDm).not.toHaveBeenCalled()
    expect(mockCreateThread).not.toHaveBeenCalled()
  })

  it("400s an invalid JSON body", async () => {
    const bad = new NextRequest("http://localhost/api/community/channels", { method: "POST", body: "{not json" })
    const res = await POST(bad)
    expect(res.status).toBe(400)
  })

  it("propagates a core's structured failure (status + error) verbatim", async () => {
    mockCreateServerChannel.mockResolvedValue({ ok: false, status: 409, error: "a channel with this name already exists" })
    const res = await POST(req({ type: "text", serverId: "s1", name: "dup" }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe("a channel with this name already exists")
  })
})
