import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockListServerInvites = vi.fn()
const mockCreateInvite = vi.fn()
const mockLogAction = vi.fn()
const mockFanOut = vi.fn()
const mockWarn = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: (...a: unknown[]) => mockWarn(...a),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    queries: {
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityInvite: {
        listServerInvites: (...a: unknown[]) => mockListServerInvites(...a),
        createInvite: (...a: unknown[]) => mockCreateInvite(...a),
      },
      communityAuditLog: {
        logAction: (...a: unknown[]) => mockLogAction(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOut(...a),
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
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

function postReq(body: unknown = {}) {
  return new NextRequest("http://localhost/api/community/servers/s1/invites", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}
const ctx = { params: { id: "s1" } } as any

describe("POST /api/community/servers/[id]/invites", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Admin caller by default.
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "admin" })
    mockListServerInvites.mockResolvedValue([])
    mockCreateInvite.mockResolvedValue({
      id: "inv_1",
      token: "tok_1",
      maxUses: null,
      uses: 0,
      expiresAt: null,
      createdAt: "2026-07-02T00:00:00.000Z",
    })
    mockFanOut.mockResolvedValue(undefined)
    mockLogAction.mockResolvedValue(undefined)
  })

  it("returns 201 with the invite and calls audit log", async () => {
    const res = await POST(postReq({}), ctx)

    expect(res.status).toBe(201)
    const body = (await res.json()) as { invite: { id: string } }
    expect(body.invite.id).toBe("inv_1")

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(expect.anything(), {
      serverId: "s1",
      actorId: "u1",
      action: "invite_create",
      targetType: "invite",
      targetId: "inv_1",
    })
  })

  it("still returns 201 when the audit write rejects (regression for the awaited outlier)", async () => {
    // Before the fix this call was `await queries.communityAuditLog.logAction(...)`
    // and would 500 the request. logAudit is fire-and-forget — the response
    // must succeed and the failure lands in log.warn.
    mockLogAction.mockRejectedValue(new Error("audit db offline"))

    const res = await POST(postReq({}), ctx)

    expect(res.status).toBe(201)
    // Flush the microtask queue so logAudit's `.catch` runs.
    await new Promise((r) => setTimeout(r, 0))
    expect(mockWarn).toHaveBeenCalledWith(
      "audit_write_failed",
      expect.objectContaining({
        action: "invite_create",
        serverId: "s1",
        targetType: "invite",
        targetId: "inv_1",
      }),
    )
  })

  it("still returns 201 when fan-out rejects (route calls helper without await/.catch)", async () => {
    // The fan-out helper's contract is to never reject; but even if it did,
    // the route treats it as fire-and-forget so the response is unaffected.
    mockFanOut.mockRejectedValue(new Error("ws-do down"))

    const res = await POST(postReq({}), ctx)
    expect(res.status).toBe(201)
  })
})
