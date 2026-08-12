import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

/**
 * Belt-and-suspenders: every friend-graph mutation route asserts
 * `ctx.user?.isBot` locally and returns 403 before any DB work. In production
 * `middleware/auth.ts` rejects a bot session at 401 first, so these tests mock
 * `withAuth` to inject a synthesized `ctx.user.isBot = true` and call the
 * handler directly — the only way to actually exercise the local assertion.
 * See plans/agent-friendship-approval-gate.md §Hardening.
 */

const getFriendship = vi.fn()
const getUserPublic = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityFriendship: {
        getFriendship: (...a: unknown[]) => getFriendship(...a),
        sendRequest: vi.fn(),
        acceptRequest: vi.fn(),
        rejectRequest: vi.fn(),
        removeFriend: vi.fn(),
        block: vi.fn(),
        unblock: vi.fn(),
        ownerDecideOnRow: vi.fn(),
        isBlocked: vi.fn(),
      },
      user: { getUserPublic: (...a: unknown[]) => getUserPublic(...a), getUserInternal: vi.fn() },
    },
  }
})

// Inject a BOT ctx to trip the local assertion.
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: {}, userId: "u_bot", email: "b@t.com", user: { isBot: true }, params })
  }),
}))

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

vi.mock("@/lib/community/fanout", () => ({ broadcastToUserSafe: vi.fn() }))
vi.mock("@/lib/community/permissions", () => ({ requireNotBlocked: vi.fn(async () => ({ ok: true })) }))

import { POST as requestPost } from "./request/route"
import { POST as acceptPost } from "./[id]/accept/route"
import { POST as rejectPost } from "./[id]/reject/route"
import { DELETE as deleteFriend } from "./[id]/route"
import { POST as ownerDecisionPost } from "./[id]/owner-decision/route"
import { POST as blockPost } from "../users/[userId]/block/route"
import { POST as unblockPost } from "../users/[userId]/unblock/route"

function jsonReq(url: string, body: unknown = {}) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("friend-graph route hardening — bot ctx yields 403", () => {
  beforeEach(() => vi.clearAllMocks())

  it("POST /friends/request → 403", async () => {
    const res = await requestPost(jsonReq("http://x/api/community/friends/request", { userId: "u2" }), {} as never)
    expect(res.status).toBe(403)
  })

  it("POST /friends/[id]/accept → 403", async () => {
    const res = await acceptPost(jsonReq("http://x/a"), { params: { id: "fr_1" } } as never)
    expect(res.status).toBe(403)
  })

  it("POST /friends/[id]/reject → 403", async () => {
    const res = await rejectPost(jsonReq("http://x/a"), { params: { id: "fr_1" } } as never)
    expect(res.status).toBe(403)
  })

  it("DELETE /friends/[id] → 403", async () => {
    const res = await deleteFriend(jsonReq("http://x/a"), { params: { id: "fr_1" } } as never)
    expect(res.status).toBe(403)
  })

  it("POST /friends/[id]/owner-decision → 403", async () => {
    const res = await ownerDecisionPost(jsonReq("http://x/a", { decision: "approve" }), { params: { id: "fr_1" } } as never)
    expect(res.status).toBe(403)
  })

  it("POST /users/[userId]/block → 403", async () => {
    const res = await blockPost(jsonReq("http://x/a"), { params: { userId: "u2" } } as never)
    expect(res.status).toBe(403)
  })

  it("POST /users/[userId]/unblock → 403", async () => {
    const res = await unblockPost(jsonReq("http://x/a"), { params: { userId: "u2" } } as never)
    expect(res.status).toBe(403)
  })
})
