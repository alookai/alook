import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetDM = vi.fn()
const mockIsBlocked = vi.fn()
const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockListMessages = vi.fn()
const mockListByMessageIds = vi.fn()
const mockListReactionsByMessageIds = vi.fn()

const mockFanOutToDM = vi.fn()
const mockBroadcastToUser = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
      },
      communityFriendship: {
        isBlocked: (...a: unknown[]) => mockIsBlocked(...a),
      },
      communityMessage: {
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        listMessages: (...a: unknown[]) => mockListMessages(...a),
      },
      communityMention: {
        createMentions: vi.fn(),
      },
      communityAttachment: {
        createAttachment: vi.fn(),
        listByMessageIds: (...a: unknown[]) => mockListByMessageIds(...a),
      },
      communityReaction: {
        listReactionsByMessageIds: (...a: unknown[]) =>
          mockListReactionsByMessageIds(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToDM: (...a: unknown[]) => mockFanOutToDM(...a),
}))

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
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

import { GET, POST } from "./route"

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/dm/d1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

function getReq() {
  return new NextRequest("http://localhost/api/community/dm/d1/messages", {
    method: "GET",
  })
}

const ctx = { params: { id: "d1" } } as any

describe("POST /api/community/dm/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDM.mockResolvedValue({
      id: "d1",
      user1Id: "u1",
      user2Id: "u2",
      lastMessageAt: null,
      createdAt: "2026-06-30T00:00:00.000Z",
    })
  })

  it("returns 403 when the DM counterpart is blocked", async () => {
    mockIsBlocked.mockResolvedValue(true)

    const res = await POST(postReq({ content: "hi" }), ctx)

    expect(res.status).toBe(403)
    expect(mockCreateMessage).not.toHaveBeenCalled()
    expect(mockFanOutToDM).not.toHaveBeenCalled()
  })
})

describe("GET /api/community/dm/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDM.mockResolvedValue({
      id: "d1",
      user1Id: "u1",
      user2Id: "u2",
      lastMessageAt: null,
      createdAt: "2026-06-30T00:00:00.000Z",
    })
  })

  it("returns 403 and never reads messages when the counterpart is blocked", async () => {
    // A blocked relationship must hide historical DM messages — the listMessages
    // query should never run for the blocked party. This is a security contract,
    // not just a UX nicety; lock it in.
    mockIsBlocked.mockResolvedValue(true)

    const res = await GET(getReq(), ctx)

    expect(res.status).toBe(403)
    expect(mockListMessages).not.toHaveBeenCalled()
  })
})
