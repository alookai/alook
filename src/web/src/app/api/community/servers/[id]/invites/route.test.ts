import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockCreateInvite = vi.fn()
const mockFanOut = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityInvite: {
        createInvite: (...a: unknown[]) => mockCreateInvite(...a),
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
    mockCreateInvite.mockResolvedValue({
      id: "inv_1",
      token: "tok_1",
      maxUses: null,
      uses: 0,
      expiresAt: null,
      createdAt: "2026-07-02T00:00:00.000Z",
    })
    mockFanOut.mockResolvedValue(undefined)
  })

  it("returns 201 with the invite", async () => {
    const res = await POST(postReq({}), ctx)

    expect(res.status).toBe(201)
    const body = (await res.json()) as { invite: { id: string } }
    expect(body.invite.id).toBe("inv_1")
    expect(mockCreateInvite).toHaveBeenCalledWith(expect.anything(), {
      serverId: "s1",
      createdBy: "u1",
      maxUses: undefined,
      expiresAt: undefined,
      maxActive: 50,
    })

  })

  it("returns 409 when the atomic insert reports the active invite cap", async () => {
    mockCreateInvite.mockResolvedValue(null)

    const res = await POST(postReq({}), ctx)

    expect(res.status).toBe(409)
    expect(mockFanOut).not.toHaveBeenCalled()
  })

  it("still returns 201 when fan-out rejects (route calls helper without await/.catch)", async () => {
    // The fan-out helper's contract is to never reject; but even if it did,
    // the route treats it as fire-and-forget so the response is unaffected.
    mockFanOut.mockRejectedValue(new Error("ws-do down"))

    const res = await POST(postReq({}), ctx)
    expect(res.status).toBe(201)
  })
})
