import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockResolveChannelAccessContext = vi.fn()
const mockGetMember = vi.fn()
const mockCreateChannelMember = vi.fn()
const mockListChannelMembers = vi.fn()
const mockGetPrivateChannelAudienceUserIds = vi.fn()
const mockGetUsersByIds = vi.fn()
const mockBroadcastToUserSafe = vi.fn()
const mockLogAudit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
        createChannelMember: (...a: unknown[]) => mockCreateChannelMember(...a),
        listChannelMembers: (...a: unknown[]) => mockListChannelMembers(...a),
        getPrivateChannelAudienceUserIds: (...a: unknown[]) => mockGetPrivateChannelAudienceUserIds(...a),
      },
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      user: { getUsersByIds: (...a: unknown[]) => mockGetUsersByIds(...a) },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
}))
vi.mock("@/lib/community/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/audit")>("@/lib/community/audit")
  return { ...actual, logAudit: (...a: unknown[]) => mockLogAudit(...a) }
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

import { GET, POST } from "./route"

const ctx = { params: { id: "c1" } } as any
function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/c1/members", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

// A private top-level channel the caller can manage.
function managerCtx() {
  return {
    channel: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
    anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
    role: "member",
    isPrivate: true,
    isChannelMember: true,
  }
}

describe("GET /channels/[id]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(managerCtx())
    mockListChannelMembers.mockResolvedValue([{ userId: "u1", addedBy: "u1", addedAt: "t", channelId: "c1", id: "cm1" }])
    mockGetUsersByIds.mockResolvedValue([{ id: "u1", name: "Ann", image: null, discriminator: "0001" }])
  })

  it("lists members for a caller with access", async () => {
    const res = await GET(new NextRequest("http://localhost/api/community/channels/c1/members"), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.members[0].userId).toBe("u1")
    expect(body.members[0].isCreator).toBe(true)
  })

  it("403 for a caller without access", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(null)
    const res = await GET(new NextRequest("http://localhost/api/community/channels/c1/members"), ctx)
    expect(res.status).toBe(403)
  })
})

describe("POST /channels/[id]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(managerCtx())
    mockGetMember.mockResolvedValue({ id: "m2", userId: "u2", role: "member" })
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["u1"])
  })

  it("adds an existing server member", async () => {
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCreateChannelMember).toHaveBeenCalledWith(expect.anything(), {
      channelId: "c1", userId: "u2", addedBy: "u1",
    })
  })

  it("rejects adding a non-server-member (400)", async () => {
    mockGetMember.mockResolvedValue(null)
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
  })

  it("rejects a non-manager (403)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({ ...managerCtx(), creatorId: "other", channel: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "other" }, anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "other" }, isChannelMember: true, role: "member" })
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(403)
  })

  it("rejects adding to a public/uncategorized channel (400)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "admin", isPrivate: false, isChannelMember: false,
    })
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(400)
  })

  it("rejects adding on a thread channel (400)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "t1", serverId: "s1", parentChannelId: "c1", creatorId: "u1" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "admin", isPrivate: true, isChannelMember: true,
    })
    const res = await POST(postReq({ userId: "u2" }), { params: { id: "t1" } } as any)
    expect(res.status).toBe(400)
  })
})
