import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetApprovalRequest = vi.fn()
const mockResolveApprovalRequest = vi.fn()
const mockLogAudit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", () => ({
  queries: {
    communityBot: {
      getApprovalRequest: (...a: unknown[]) => mockGetApprovalRequest(...a),
      resolveApprovalRequest: (...a: unknown[]) => mockResolveApprovalRequest(...a),
    },
  },
}))

vi.mock("@/lib/community/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
  COMMUNITY_AUDIT_ACTIONS: { BOT_FRIEND_CANCELLED: "bot_friend_cancelled" },
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (_req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(_req, { env: { DB: {} }, userId: "u_me", email: "m@t.com", params })
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

const ctx = { params: { requestId: "bar_1" } } as any

describe("POST /api/community/friends/bot-request/[requestId]/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetApprovalRequest.mockResolvedValue({
      id: "bar_1",
      botId: "u_bot",
      status: "pending",
      kind: "friend",
      serverId: null,
      requestedByUserId: "u_me",
    })
    mockResolveApprovalRequest.mockResolvedValue(undefined)
  })

  it("cancels the caller's own pending bot friend-request", async () => {
    const res = await POST({} as any, ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "cancelled" })
    expect(mockResolveApprovalRequest).toHaveBeenCalledWith(expect.anything(), "bar_1", "denied")
    expect(mockLogAudit).toHaveBeenCalled()
  })

  it("returns 404 when the request belongs to a different requester", async () => {
    mockGetApprovalRequest.mockResolvedValue({
      id: "bar_1", botId: "u_bot", status: "pending", kind: "friend",
      serverId: null, requestedByUserId: "u_other",
    })
    const res = await POST({} as any, ctx)
    expect(res.status).toBe(404)
    expect(mockResolveApprovalRequest).not.toHaveBeenCalled()
  })

  it("returns 404 when the request is not a friend kind", async () => {
    mockGetApprovalRequest.mockResolvedValue({
      id: "bar_1", botId: "u_bot", status: "pending", kind: "join_server",
      serverId: "s_1", requestedByUserId: "u_me",
    })
    const res = await POST({} as any, ctx)
    expect(res.status).toBe(404)
  })

  it("returns 400 when the request is already resolved", async () => {
    mockGetApprovalRequest.mockResolvedValue({
      id: "bar_1", botId: "u_bot", status: "approved", kind: "friend",
      serverId: null, requestedByUserId: "u_me",
    })
    const res = await POST({} as any, ctx)
    expect(res.status).toBe(400)
    expect(mockResolveApprovalRequest).not.toHaveBeenCalled()
  })
})
