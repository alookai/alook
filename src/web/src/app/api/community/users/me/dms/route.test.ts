import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockListDMs = vi.fn()
const mockListEligibleUnreadDms = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityDm: {
        listDMs: (...a: unknown[]) => mockListDMs(...a),
      },
      communityInbox: {
        listEligibleUnreadDms: (...a: unknown[]) => mockListEligibleUnreadDms(...a),
      },
      communityFriendship: {
        isBlocked: vi.fn(),
      },
      user: {
        getUser: vi.fn(),
      },
    },
  }
})

vi.mock("@/lib/community/permissions", () => ({
  requireNotBlocked: vi.fn(),
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

import { GET } from "./route"

function getReq() {
  return new NextRequest("http://localhost/api/community/users/me/dms", { method: "GET" })
}

describe("GET /api/community/users/me/dms — name projection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListEligibleUnreadDms.mockResolvedValue([])
  })

  it("returns the counterpart's user.name verbatim (no email fallback)", async () => {
    // Post-migration 0050, user.name is CHECK-constrained non-empty. The
    // response contract is "return the name field, period" — no fallback to
    // otherUserEmail, no "Unknown" sentinel. The test locks that in so a
    // regression that reintroduces the cascade fails loudly.
    mockListDMs.mockResolvedValue([
      {
        id: "d1",
        otherUserId: "u2",
        otherUserName: "Alice",
        otherUserEmail: "alice@example.com",
        otherUserImage: null,
        lastMessageAt: null,
        createdAt: "2026-06-30T00:00:00.000Z",
      },
    ])
    const res = await GET(getReq(), {} as any)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      conversations: Array<{ id: string; name: string; avatar: string }>
    }
    expect(body.conversations[0]?.name).toBe("Alice")
    expect(body.conversations[0]?.name).not.toContain("@")
    expect(body.conversations[0]?.avatar).toBe("A")
  })

  it("projects canonical unread state and its sequence evidence", async () => {
    mockListDMs.mockResolvedValue([{
      id: "d1",
      otherUserId: "u2",
      otherUserName: "Alice",
      otherUserEmail: "alice@example.com",
      otherUserImage: null,
      otherUserAvatarVersion: 0,
      otherUserDiscriminator: "0001",
      lastMessageAt: "2026-06-30T00:00:00.000Z",
      createdAt: "2026-06-30T00:00:00.000Z",
    }])
    mockListEligibleUnreadDms.mockResolvedValue([{
      channelId: "d1",
      lastUnreadSeq: 9,
    }])

    const res = await GET(getReq(), {} as any)
    expect((await res.json()).conversations[0]).toMatchObject({
      id: "d1",
      unread: true,
      lastUnreadSeq: 9,
    })
  })
})
