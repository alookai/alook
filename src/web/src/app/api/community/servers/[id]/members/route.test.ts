import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockListMembersPaginated = vi.fn()
const mockCountMembers = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
        listMembersPaginated: (...a: unknown[]) => mockListMembersPaginated(...a),
        countMembers: (...a: unknown[]) => mockCountMembers(...a),
      },
    },
  }
})

let authOverride: { userId?: string; unauth?: boolean } = {}
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    if (authOverride.unauth) {
      const { NextResponse } = require("next/server")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: authOverride.userId ?? "u1", email: "u@t.com", params })
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
import { MAX_MEMBERS_PAGE_SIZE, DEFAULT_MEMBERS_PAGE_SIZE } from "@alook/shared"

function buildRow(i: number) {
  return {
    id: `mem_${i}`,
    serverId: "srv_1",
    userId: `u_${i}`,
    role: "member",
    nickname: null,
    joinedAt: `2025-01-${String(i).padStart(2, "0")}T00:00:00.000Z`,
    userName: `User ${i}`,
    userEmail: `u${i}@x.com`,
    userImage: null,
    discriminator: String(i).padStart(4, "0"),
  }
}

function getReq(query = "") {
  return new NextRequest(`http://localhost/api/community/servers/srv_1/members${query}`, { method: "GET" })
}

const ctx = { params: { id: "srv_1" } } as any

describe("GET /api/community/servers/[id]/members — cursor envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authOverride = {}
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u_1", serverId: "srv_1", role: "member" })
  })

  it("returns page 1 + non-empty cursor when hasMore=true", async () => {
    const rows = [buildRow(1), buildRow(2), buildRow(3)]
    mockListMembersPaginated.mockResolvedValue({
      members: rows,
      hasMore: true,
      cursor: { joinedAt: rows[2].joinedAt, id: rows[2].id },
    })
    mockCountMembers.mockResolvedValue(500)

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { members: Array<{ id: string }>; hasMore: boolean; cursor: string; limit: number; total: number }
    expect(body.members.map((m) => m.id)).toEqual(["mem_1", "mem_2", "mem_3"])
    expect(body.hasMore).toBe(true)
    expect(body.cursor).toBe(`${rows[2].joinedAt}|${rows[2].id}`)
    expect(body.total).toBe(500)
  })

  it("passes cursor through to the query and returns hasMore=false at the tail", async () => {
    const rows = [buildRow(4), buildRow(5)]
    mockListMembersPaginated.mockResolvedValue({ members: rows, hasMore: false, cursor: undefined })
    mockCountMembers.mockResolvedValue(5)

    const cursorParam = "2025-01-03T00:00:00.000Z|mem_3"
    const res = await GET(getReq(`?cursor=${encodeURIComponent(cursorParam)}`), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { members: Array<{ id: string }>; hasMore: boolean; cursor: string | undefined; total: number }
    expect(body.members.map((m) => m.id)).toEqual(["mem_4", "mem_5"])
    expect(body.hasMore).toBe(false)
    expect(body.cursor).toBeUndefined()
    expect(body.total).toBe(5)

    // Verify the parsed cursor made it to the query as { joinedAt, id }.
    const call = mockListMembersPaginated.mock.calls[0]
    expect(call[2].cursor).toEqual({ joinedAt: "2025-01-03T00:00:00.000Z", id: "mem_3" })
  })

  it("page 1 + page 2 concatenate without duplicates or gaps against a seeded fixture", async () => {
    const all = [buildRow(1), buildRow(2), buildRow(3), buildRow(4)]

    // Page 1
    mockListMembersPaginated.mockResolvedValueOnce({
      members: all.slice(0, 2),
      hasMore: true,
      cursor: { joinedAt: all[1].joinedAt, id: all[1].id },
    })
    mockCountMembers.mockResolvedValue(4)
    const res1 = await GET(getReq("?limit=2"), ctx)
    const body1 = await res1.json() as { members: Array<{ id: string }>; cursor: string }

    // Page 2
    mockListMembersPaginated.mockResolvedValueOnce({
      members: all.slice(2, 4),
      hasMore: false,
      cursor: undefined,
    })
    const res2 = await GET(getReq(`?limit=2&cursor=${encodeURIComponent(body1.cursor)}`), ctx)
    const body2 = await res2.json() as { members: Array<{ id: string }>; hasMore: boolean }

    const combined = [...body1.members, ...body2.members].map((m) => m.id)
    expect(combined).toEqual(["mem_1", "mem_2", "mem_3", "mem_4"])
    expect(new Set(combined).size).toBe(4)
    expect(body2.hasMore).toBe(false)
  })

  it("clamps limit above MAX_MEMBERS_PAGE_SIZE down to the cap", async () => {
    mockListMembersPaginated.mockResolvedValue({ members: [], hasMore: false, cursor: undefined })
    mockCountMembers.mockResolvedValue(0)

    const res = await GET(getReq("?limit=9999"), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { limit: number }
    expect(body.limit).toBe(MAX_MEMBERS_PAGE_SIZE)

    const call = mockListMembersPaginated.mock.calls[0]
    expect(call[2].limit).toBe(MAX_MEMBERS_PAGE_SIZE)
  })

  it("defaults to DEFAULT_MEMBERS_PAGE_SIZE when limit omitted", async () => {
    mockListMembersPaginated.mockResolvedValue({ members: [], hasMore: false, cursor: undefined })
    mockCountMembers.mockResolvedValue(0)

    const res = await GET(getReq(), ctx)
    const body = await res.json() as { limit: number }
    expect(body.limit).toBe(DEFAULT_MEMBERS_PAGE_SIZE)
  })

  it("includes each member's discriminator in the response", async () => {
    const rows = [buildRow(1), buildRow(2)]
    mockListMembersPaginated.mockResolvedValue({ members: rows, hasMore: false, cursor: undefined })
    mockCountMembers.mockResolvedValue(2)

    const res = await GET(getReq(), ctx)
    const body = await res.json() as { members: Array<{ discriminator?: string }> }
    expect(body.members.map((m) => m.discriminator)).toEqual(["0001", "0002"])
  })

  it("returns 403 for non-members (permission check ahead of the query)", async () => {
    mockGetMember.mockResolvedValue(null)
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockListMembersPaginated).not.toHaveBeenCalled()
  })

  it("returns 401 for unauth callers via the withAuth guard", async () => {
    authOverride = { unauth: true }
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(401)
  })

  it("envelope key set is { members, hasMore, cursor?, limit, total }", async () => {
    // cursor is omitted from the JSON when hasMore=false (undefined values
    // are dropped by NextResponse.json). Assert the core keys are present.
    mockListMembersPaginated.mockResolvedValue({ members: [buildRow(1)], hasMore: false, cursor: undefined })
    mockCountMembers.mockResolvedValue(1)
    const res = await GET(getReq(), ctx)
    const body = await res.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(["hasMore", "limit", "members", "total"])

    // When hasMore=true the cursor key IS present.
    mockListMembersPaginated.mockResolvedValue({
      members: [buildRow(1)],
      hasMore: true,
      cursor: { joinedAt: "2025-01-01T00:00:00.000Z", id: "mem_1" },
    })
    const res2 = await GET(getReq(), ctx)
    const body2 = await res2.json() as Record<string, unknown>
    expect(Object.keys(body2).sort()).toEqual(["cursor", "hasMore", "limit", "members", "total"])
  })
})
