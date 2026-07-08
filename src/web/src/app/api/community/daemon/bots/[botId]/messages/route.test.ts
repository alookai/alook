import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockGetChannel = vi.fn()
const mockGetMember = vi.fn()
const mockCreateCommunityMessage = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityChannel: { getChannel: (...a: unknown[]) => mockGetChannel(...a) },
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
    },
  }
})

vi.mock("@/lib/community/message-handler", () => ({
  createCommunityMessage: (...a: unknown[]) => mockCreateCommunityMessage(...a),
}))

vi.mock("@/lib/community/audit", () => ({ logAudit: vi.fn(), COMMUNITY_AUDIT_ACTIONS: {} }))

vi.mock("@/lib/community/permissions", () => ({
  requireNotBlocked: vi.fn(async () => ({ ok: true })),
}))

vi.mock("@/lib/middleware/community-daemon-auth", () => ({
  withCommunityDaemonAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, {
      env: { DB: {} },
      userId: "u_owner",
      machineId: "machine_1",
      params,
    })
  }),
}))

import { POST } from "./route"

const ctx = { params: { botId: "bot_1" } } as any

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/daemon/bots/bot_1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

describe("POST /api/community/daemon/bots/[botId]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserInternal.mockResolvedValue({
      id: "bot_1",
      isBot: true,
      ownerUserId: "u_owner",
      deletedAt: null,
    })
    mockGetBotBinding.mockResolvedValue({ machineId: "machine_1" })
    mockGetChannel.mockResolvedValue({ id: "ch_1", serverId: "srv_1" })
    mockGetMember.mockResolvedValue({ id: "mem_bot" })
    mockCreateCommunityMessage.mockResolvedValue({
      ok: true,
      row: { id: "msg_1" },
    })
  })

  it("returns 403 when the bot is not a member of the target channel's server", async () => {
    mockGetMember.mockResolvedValue(null)
    const res = await POST(
      postReq({ target: "channel", targetId: "ch_1", content: "hi" }),
      ctx,
    )
    expect(res.status).toBe(403)
    expect(mockCreateCommunityMessage).not.toHaveBeenCalled()
  })

  it("returns 201 and messageId when the bot sends to a channel it belongs to", async () => {
    const res = await POST(
      postReq({ target: "channel", targetId: "ch_1", content: "hello from bot" }),
      ctx,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.messageId).toBe("msg_1")
    expect(mockCreateCommunityMessage).toHaveBeenCalled()
  })
})
