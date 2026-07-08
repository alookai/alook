import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetBotOwnedBy = vi.fn()
const mockGetApprovalRequest = vi.fn()
const mockGetMember = vi.fn()
const mockAddMember = vi.fn()
const mockResolveApprovalRequest = vi.fn()
const mockLogAudit = vi.fn()
const mockFanOut = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBot: {
        getBotOwnedBy: (...a: unknown[]) => mockGetBotOwnedBy(...a),
        getApprovalRequest: (...a: unknown[]) => mockGetApprovalRequest(...a),
        resolveApprovalRequest: (...a: unknown[]) => mockResolveApprovalRequest(...a),
      },
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
        addMember: (...a: unknown[]) => mockAddMember(...a),
      },
    },
  }
})

vi.mock("@/lib/community/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
  COMMUNITY_AUDIT_ACTIONS: {
    BOT_JOIN_APPROVED: "bot_join_approved",
    BOT_ADDED_TO_SERVER: "bot_added_to_server",
    BOT_FRIEND_APPROVED: "bot_friend_approved",
  },
}))

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOut(...a),
  broadcastToUserSafe: vi.fn(),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (_req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(_req, { env: { DB: {} }, userId: "u_owner", email: "o@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

const ctx = { params: { id: "bot_1", requestId: "req_1" } } as any

describe("POST /api/community/bots/[id]/approval-requests/[requestId]/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBotOwnedBy.mockResolvedValue({
      id: "bot_1",
      name: "Zoe",
      image: null,
    })
    mockGetApprovalRequest.mockResolvedValue({
      id: "req_1",
      botId: "bot_1",
      status: "pending",
      kind: "join_server",
      serverId: "srv_1",
      requestedByUserId: "u_friend",
    })
    mockGetMember.mockResolvedValue(null)
    mockAddMember.mockResolvedValue({
      id: "mem_bot",
      role: "member",
      joinedAt: "2026-07-08T00:00:00.000Z",
    })
    mockResolveApprovalRequest.mockResolvedValue(undefined)
    mockFanOut.mockResolvedValue(undefined)
  })

  it("returns 404 when the bot is not owned by the caller", async () => {
    mockGetBotOwnedBy.mockResolvedValue(null)
    const res = await POST({} as any, ctx)
    expect(res.status).toBe(404)
  })

  it("returns 400 when the request is already resolved", async () => {
    mockGetApprovalRequest.mockResolvedValue({
      id: "req_1",
      botId: "bot_1",
      status: "approved",
      kind: "join_server",
      serverId: "srv_1",
      requestedByUserId: "u_friend",
    })
    const res = await POST({} as any, ctx)
    expect(res.status).toBe(400)
  })

  it("approves a join_server request and fans out MEMBER_JOIN", async () => {
    const res = await POST({} as any, ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: "approved", kind: "join_server" })
    expect(mockAddMember).toHaveBeenCalled()
    expect(mockFanOut).toHaveBeenCalledWith(
      "srv_1",
      expect.objectContaining({ type: "community:member.join" }),
    )
  })
})
