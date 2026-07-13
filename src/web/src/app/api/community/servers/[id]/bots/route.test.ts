import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockGetMember = vi.fn()
const mockGetUserInternal = vi.fn()
const mockAddMember = vi.fn()
const mockGetUserSelf = vi.fn()
const mockAreFriends = vi.fn()
const mockFindPendingJoinRequest = vi.fn()
const mockCreateOrGetDM = vi.fn()
const mockCreateApprovalRequestStatement = vi.fn()
const mockHardDeleteMessage = vi.fn()
const mockLogError = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: (...a: unknown[]) => mockLogError(...a),
      debug: vi.fn(),
    }),
    queries: {
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
        addMember: (...a: unknown[]) => mockAddMember(...a),
      },
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
        getUserSelf: (...a: unknown[]) => mockGetUserSelf(...a),
      },
      communityFriendship: {
        areFriends: (...a: unknown[]) => mockAreFriends(...a),
      },
      communityBot: {
        findPendingJoinRequest: (...a: unknown[]) => mockFindPendingJoinRequest(...a),
        createApprovalRequestStatement: (...a: unknown[]) => mockCreateApprovalRequestStatement(...a),
      },
      communityDm: {
        createOrGetDM: (...a: unknown[]) => mockCreateOrGetDM(...a),
      },
      communityMessage: {
        hardDeleteMessage: (...a: unknown[]) => mockHardDeleteMessage(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: vi.fn(),
  broadcastToUserSafe: vi.fn(),
}))

vi.mock("@/lib/community/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/audit")>("@/lib/community/audit")
  return { ...actual, logAudit: vi.fn() }
})

const mockCreateCommunityMessage = vi.fn()
vi.mock("@/lib/community/message-handler", () => ({
  createCommunityMessage: (...a: unknown[]) => mockCreateCommunityMessage(...a),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  }),
}))

import { POST } from "./route"

const ctx = { params: { id: "s1" } } as any
function req(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/s1/bots", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("POST /servers/[id]/bots — approval-request rollback failure", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Friend-of-bot-add (Path B): caller is a member, target is a bot owned
    // by someone else, caller is friends with the bot.
    mockGetMember.mockResolvedValue({ id: "m1", nickname: "Casey" })
    mockGetUserInternal.mockResolvedValue({
      id: "bot1",
      isBot: true,
      deletedAt: null,
      ownerUserId: "owner1",
      name: "Bot",
    })
    mockAreFriends.mockResolvedValue(true)
    mockFindPendingJoinRequest.mockResolvedValue(null)
    mockCreateOrGetDM.mockResolvedValue({ id: "dm1" })
    mockCreateCommunityMessage.mockResolvedValue({
      ok: true,
      row: { id: "msg1", content: "Casey wants to add me to a server. Approve?", createdAt: "2026-01-01T00:00:00Z" },
    })
  })

  it("returns 500 with the rollback exception's message when both the approval-request insert AND the compensating delete fail", async () => {
    mockCreateApprovalRequestStatement.mockRejectedValue(new Error("insert failed"))
    mockHardDeleteMessage.mockRejectedValue(new Error("delete failed"))

    const res = await POST(req({ botId: "bot1" }), ctx)

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain("delete failed")
    expect(body.error).toContain("approval request write failed")
    expect(mockLogError).toHaveBeenCalledWith(
      "approval_request_rollback_failed",
      expect.objectContaining({
        botId: "bot1",
        serverId: "s1",
        messageId: "msg1",
        insertErr: expect.stringContaining("insert failed"),
        rollbackErr: expect.stringContaining("delete failed"),
      }),
    )
  })

  it("returns 200 pending when the insert fails but the compensating delete succeeds (race lost, not a rollback failure)", async () => {
    mockCreateApprovalRequestStatement.mockRejectedValue(new Error("insert failed"))
    mockHardDeleteMessage.mockResolvedValue(undefined)

    const res = await POST(req({ botId: "bot1" }), ctx)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "pending" })
  })
})
