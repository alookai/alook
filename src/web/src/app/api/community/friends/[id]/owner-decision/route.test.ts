import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockOwnerDecideOnRow = vi.fn()
const mockBroadcastToUser = vi.fn(async () => undefined)
const mockLogAudit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityFriendship: { ownerDecideOnRow: (...a: unknown[]) => mockOwnerDecideOnRow(...a) },
    },
  }
})

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}))
vi.mock("@/lib/community/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/audit")>("@/lib/community/audit")
  return { ...actual, logAudit: (...a: unknown[]) => mockLogAudit(...a) }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: {}, userId: "owner_bob", email: "b@t.com", user: { isBot: false }, params })
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

function req(body: unknown) {
  return new NextRequest("http://localhost/api/community/friends/fr_1/owner-decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
const ctx = { params: { id: "fr_1" } } as any

describe("POST /api/community/friends/[id]/owner-decision", () => {
  beforeEach(() => vi.clearAllMocks())

  it("400 on an unknown decision value", async () => {
    const res = await POST(req({ decision: "maybe" }), ctx)
    expect(res.status).toBe(400)
    expect(mockOwnerDecideOnRow).not.toHaveBeenCalled()
  })

  it("approve: relays broadcasts and writes an audit row", async () => {
    mockOwnerDecideOnRow.mockResolvedValue({
      ok: true,
      friendship: { id: "fr_1", status: "accepted" },
      broadcasts: [{ userId: "u_alice", event: { type: "community:friend.accept", friendshipId: "fr_1" } }],
    })
    const res = await POST(req({ decision: "approve" }), ctx)
    expect(res.status).toBe(200)
    expect(mockBroadcastToUser).toHaveBeenCalledWith("u_alice", expect.objectContaining({ type: "community:friend.accept" }))
    expect(mockLogAudit).toHaveBeenCalled()
  })

  it("deny: single-owner broadcast, denied status", async () => {
    mockOwnerDecideOnRow.mockResolvedValue({
      ok: true,
      friendship: { id: "fr_1", status: "denied" },
      broadcasts: [{ userId: "owner_bob", event: { type: "community:dm.message_updated" } }],
    })
    const res = await POST(req({ decision: "deny" }), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("denied")
  })

  it("wrong actor: 403", async () => {
    mockOwnerDecideOnRow.mockResolvedValue({ ok: false, reason: "forbidden" })
    const res = await POST(req({ decision: "approve" }), ctx)
    expect(res.status).toBe(403)
  })

  it("already-resolved row: 409", async () => {
    mockOwnerDecideOnRow.mockResolvedValue({ ok: false, reason: "already_resolved" })
    const res = await POST(req({ decision: "approve" }), ctx)
    expect(res.status).toBe(409)
  })
})
