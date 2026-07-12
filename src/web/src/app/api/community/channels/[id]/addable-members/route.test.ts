import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockResolveChannelAccessContext = vi.fn()
const mockListMembers = vi.fn()
const mockListChannelMemberUserIds = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
        listChannelMemberUserIds: (...a: unknown[]) => mockListChannelMemberUserIds(...a),
      },
      communityMember: { listMembers: (...a: unknown[]) => mockListMembers(...a) },
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

const ctx = { params: { id: "c1" } } as any
function req() {
  return new NextRequest("http://localhost/api/community/channels/c1/addable-members")
}

function managerCtx() {
  return {
    channel: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
    anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
    role: "member",
    isPrivate: true,
    isChannelMember: true,
  }
}

describe("GET /channels/[id]/addable-members", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(managerCtx())
    mockListMembers.mockResolvedValue([
      { userId: "u1", userName: "Creator", userImage: null, discriminator: "0001" },
      { userId: "u2", userName: "Bob", userImage: null, discriminator: "0002" },
      { userId: "u3", userName: "Cara", userImage: null, discriminator: "0003" },
    ])
    mockListChannelMemberUserIds.mockResolvedValue(["u2"])
  })

  it("excludes existing channel members and the creator", async () => {
    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.members.map((m: { userId: string }) => m.userId)
    expect(ids).toEqual(["u3"]) // u1 = creator, u2 = already member
  })

  it("rejects a non-manager (403)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      ...managerCtx(),
      channel: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "other" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "other" },
      role: "member",
      isChannelMember: true,
    })
    const res = await GET(req(), ctx)
    expect(res.status).toBe(403)
  })
})
