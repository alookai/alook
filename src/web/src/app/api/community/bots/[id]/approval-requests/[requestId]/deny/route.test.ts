import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetBotOwnedBy = vi.fn()
const mockGetApprovalRequest = vi.fn()
const mockResolveApprovalRequest = vi.fn()
const mockLogAudit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", () => ({
  queries: {
    communityBot: {
      getBotOwnedBy: (...a: unknown[]) => mockGetBotOwnedBy(...a),
      getApprovalRequest: (...a: unknown[]) => mockGetApprovalRequest(...a),
      resolveApprovalRequest: (...a: unknown[]) => mockResolveApprovalRequest(...a),
    },
  },
}))

vi.mock("@/lib/community/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
  COMMUNITY_AUDIT_ACTIONS: {
    BOT_JOIN_DENIED: "bot_join_denied",
    BOT_FRIEND_DENIED: "bot_friend_denied",
  },
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

describe("POST /api/community/bots/[id]/approval-requests/[requestId]/deny", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBotOwnedBy.mockResolvedValue({ id: "bot_1", name: "Zoe", image: null })
    mockGetApprovalRequest.mockResolvedValue({
      id: "req_1",
      botId: "bot_1",
      status: "pending",
      kind: "friend",
      serverId: null,
      requestedByUserId: "u_friend",
    })
    mockResolveApprovalRequest.mockResolvedValue(undefined)
  })

  it("returns 404 when the bot is not owned by the caller", async () => {
    mockGetBotOwnedBy.mockResolvedValue(null)
    const res = await POST({} as any, ctx)
    expect(res.status).toBe(404)
  })

  it("denies a pending request and writes audit", async () => {
    const res = await POST({} as any, ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: "denied", kind: "friend" })
    expect(mockResolveApprovalRequest).toHaveBeenCalledWith(
      expect.anything(),
      "req_1",
      "denied",
    )
    expect(mockLogAudit).toHaveBeenCalled()
  })
})
