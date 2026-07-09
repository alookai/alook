import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockSearchMembers = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
        searchMembers: (...a: unknown[]) => mockSearchMembers(...a),
      },
    },
  }
})

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
import { MAX_MEMBERS_PAGE_SIZE } from "@alook/shared"

function getReq(query: string) {
  return new NextRequest(`http://localhost/api/community/servers/srv_1/members/search${query}`, { method: "GET" })
}

const ctx = { params: { id: "srv_1" } } as any

function buildRow(i: number, name: string) {
  return {
    id: `mem_${i}`,
    serverId: "srv_1",
    userId: `u_${i}`,
    role: "member",
    nickname: null,
    joinedAt: `2025-01-${String(i).padStart(2, "0")}T00:00:00.000Z`,
    userName: name,
    userEmail: `${name.toLowerCase()}@x.com`,
    userImage: null,
  }
}

describe("GET /api/community/servers/[id]/members/search", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", serverId: "srv_1", role: "member" })
  })

  it("returns matched members as display shape with { members, limit } envelope", async () => {
    mockSearchMembers.mockResolvedValue([buildRow(1, "Alice"), buildRow(2, "Alicia")])
    const res = await GET(getReq("?q=Ali"), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { members: Array<{ id: string; name: string }>; limit: number }
    expect(body.members.map((m) => m.name)).toEqual(["Alice", "Alicia"])
    expect(body.limit).toBe(MAX_MEMBERS_PAGE_SIZE)
  })

  it("rejects empty q with 400", async () => {
    const res = await GET(getReq(""), ctx)
    expect(res.status).toBe(400)
    expect(mockSearchMembers).not.toHaveBeenCalled()

    const res2 = await GET(getReq("?q="), ctx)
    expect(res2.status).toBe(400)
    expect(mockSearchMembers).not.toHaveBeenCalled()

    // whitespace-only trims to empty and also rejects
    const res3 = await GET(getReq("?q=%20%20"), ctx)
    expect(res3.status).toBe(400)
  })

  it("returns 403 for non-members", async () => {
    mockGetMember.mockResolvedValue(null)
    const res = await GET(getReq("?q=A"), ctx)
    expect(res.status).toBe(403)
    expect(mockSearchMembers).not.toHaveBeenCalled()
  })

  it("clamps limit param to MAX_MEMBERS_PAGE_SIZE", async () => {
    mockSearchMembers.mockResolvedValue([])
    const res = await GET(getReq(`?q=A&limit=9999`), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { limit: number }
    expect(body.limit).toBe(MAX_MEMBERS_PAGE_SIZE)
    const call = mockSearchMembers.mock.calls[0]
    expect(call[3].limit).toBe(MAX_MEMBERS_PAGE_SIZE)
  })

  it("forwards q verbatim to the query (LIKE-escape happens inside the query)", async () => {
    mockSearchMembers.mockResolvedValue([])
    await GET(getReq(`?q=${encodeURIComponent("50%_off")}`), ctx)
    const call = mockSearchMembers.mock.calls[0]
    expect(call[2]).toBe("50%_off")
  })
})
