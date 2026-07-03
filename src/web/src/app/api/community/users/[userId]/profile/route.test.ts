import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

const mockGetUser = vi.fn()
const mockGetProfile = vi.fn()
const mockListMemberServerIds = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      user: { getUser: (...a: unknown[]) => mockGetUser(...a) },
      communityUserProfile: { getProfile: (...a: unknown[]) => mockGetProfile(...a) },
      communityMember: {
        listMemberServerIds: (...a: unknown[]) => mockListMemberServerIds(...a),
      },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  },
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

function req() {
  return new NextRequest("http://localhost/api/community/users/u2/profile", { method: "GET" })
}

function ctx() {
  return { params: Promise.resolve({ userId: "u2" }) } as any
}

describe("GET /api/community/users/[userId]/profile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUser.mockResolvedValue({
      id: "u2",
      name: "Bob",
      email: "bob@t.com",
      image: "https://x/y.png",
    })
    mockGetProfile.mockResolvedValue({ aboutMe: "hi", bannerColor: "#123456" })
    mockListMemberServerIds.mockImplementation(async (_db: unknown, userId: string) => {
      if (userId === "u1") return ["s1", "s2"]
      if (userId === "u2") return ["s2", "s3"]
      return []
    })
  })

  it("does not include email in the response payload", async () => {
    const res = await GET(req(), ctx())
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).not.toHaveProperty("email")
    expect(body).toEqual({
      id: "u2",
      name: "Bob",
      image: "https://x/y.png",
      aboutMe: "hi",
      bannerColor: "#123456",
      mutualServers: 1,
    })
  })
})
