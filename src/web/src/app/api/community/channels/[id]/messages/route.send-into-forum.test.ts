import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })) }))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockCreateMessageWithThread = vi.fn()
const mockResolveTargetForMember = vi.fn()
const mockRequireMessageSurfaceAccess = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityAgentInbox: {
        ...actual.queries.communityAgentInbox,
        toAgentMessage: vi.fn(async (_db, row) => ({ id: row.id, content: row.content, seq: row.seq ?? 1 })),
      },
    },
  }
})
vi.mock("@/lib/community/resolve-ref", () => ({ resolveTargetForMember: (...args: unknown[]) => mockResolveTargetForMember(...args) }))
vi.mock("@/lib/community/permissions", () => ({ requireMessageSurfaceAccess: (...args: unknown[]) => mockRequireMessageSurfaceAccess(...args) }))
vi.mock("@/lib/community/create-channels", () => ({ createMessageWithThread: (...args: unknown[]) => mockCreateMessageWithThread(...args) }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }))
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: any, ctx?: any) => handler(req, {
    env: { DB: {} },
    actor: { kind: "bot", userId: "bot_1", ownerUserId: "owner_1", machineId: "m_1" },
    params: ctx?.params instanceof Promise ? await ctx.params : ctx?.params,
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

const ctx = { params: { id: "resolve" } } as any
const request = (body: unknown) => new NextRequest("http://localhost/api/community/channels/resolve/messages", {
  method: "POST",
  headers: { Authorization: "Bearer crk_abc", "content-type": "application/json" },
  body: JSON.stringify(body),
})

describe("forum sends open a thread through the canonical message route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveTargetForMember.mockResolvedValue({ channelId: "forum_1" })
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "forum_1", serverId: "server_1", type: "forum", parentChannelId: null } },
    })
    mockCreateMessageWithThread.mockResolvedValue({
      ok: true,
      message: { id: "message_1", content: "Title", seq: 5 },
      attachments: [],
      thread: { id: "thread_1" },
    })
  })

  it("creates only the opener and structural child thread", async () => {
    const response = await POST(request({ channel: "/demo/forum", content: { text: "Title" }, nonce: "command:opener" }), ctx)

    expect(response.status).toBe(200)
    expect(mockCreateMessageWithThread).toHaveBeenCalledWith(expect.objectContaining({
      authorId: "bot_1",
      parentChannelId: "forum_1",
      serverId: "server_1",
      body: { content: "Title" },
      pendingAttachmentIdsToRebind: [],
      clientNonce: "command:opener",
    }))
    expect(await response.json()).toEqual(expect.objectContaining({ state: "sent", threadId: "thread_1" }))
  })

  it("passes pending attachment ids to the structural primitive for scope-safe rebind", async () => {
    await POST(request({ channel: "/demo/forum", content: { text: "Title" }, attachments: ["attachment_1"] }), ctx)

    expect(mockCreateMessageWithThread).toHaveBeenCalledWith(expect.objectContaining({
      pendingAttachmentIdsToRebind: ["attachment_1"],
      attachmentIds: undefined,
    }))
  })

  it("accepts a deduped opener replay without a pending-attachment precheck", async () => {
    mockCreateMessageWithThread.mockResolvedValueOnce({
      ok: true,
      deduped: true,
      message: { id: "message_1", content: "Title", seq: 5 },
      attachments: [],
      thread: { id: "thread_1" },
    })

    const response = await POST(request({ channel: "/demo/forum", content: { text: "Title" }, attachments: ["attachment_1"], nonce: "command:opener" }), ctx)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({ deduped: true, threadId: "thread_1" }))
  })

  it("does not open a nested thread for an ordinary thread target", async () => {
    mockRequireMessageSurfaceAccess.mockResolvedValueOnce({
      ok: true,
      value: { surface: "channel", channel: { id: "thread_1", serverId: "server_1", type: "thread", parentChannelId: "forum_1" } },
    })

    await expect(POST(request({ channel: "/demo/forum/#5", content: { text: "Body" } }), ctx)).rejects.toThrow()
    expect(mockCreateMessageWithThread).not.toHaveBeenCalled()
  })

  it("propagates structural primitive failures", async () => {
    mockCreateMessageWithThread.mockResolvedValueOnce({ ok: false, status: 400, error: "attachment not found or not attachable to this thread" })

    const response = await POST(request({ channel: "/demo/forum", content: { text: "Title" }, attachments: ["stolen"] }), ctx)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "attachment not found or not attachable to this thread" })
  })
})
