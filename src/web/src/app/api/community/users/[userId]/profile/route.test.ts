import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getPublicProfileForViewer = vi.fn()
const listMemberServerIds = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityUserProfile: {
        getPublicProfileForViewer: (...a: unknown[]) => getPublicProfileForViewer(...a),
      },
      communityMember: { listMemberServerIds: (...a: unknown[]) => listMemberServerIds(...a) },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: {}, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

const req = new NextRequest("http://localhost/api/community/users/u2/profile")

describe("GET /api/community/users/[userId]/profile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPublicProfileForViewer.mockResolvedValue({
      id: "u2",
      name: "Gus",
      discriminator: "1337",
      image: null,
      aboutMe: "hi",
      bannerColor: null,
      statusEmoji: "🎧",
      statusText: "Vibing",
      identity: { kind: "human" },
    })
    listMemberServerIds.mockImplementation(async (_db: unknown, userId: string) => {
      if (userId === "u1") return ["s1", "s2"]
      if (userId === "u2") return ["s2", "s3"]
      return []
    })
  })

  it("returns the exact human profile union and does not include private identity fields", async () => {
    const res = await GET(req, { params: { userId: "u2" } } as never)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).not.toHaveProperty("email")
    expect(body).not.toHaveProperty("ownerUserId")
    expect(body).not.toHaveProperty("isBot")
    expect(body).toEqual({
      id: "u2",
      name: "Gus",
      discriminator: "1337",
      image: null,
      aboutMe: "hi",
      bannerColor: null,
      mutualServers: 1,
      statusEmoji: "🎧",
      statusText: "Vibing",
      kind: "human",
    })
    expect(getPublicProfileForViewer).toHaveBeenCalledWith(expect.anything(), "u2", "u1")
  })

  it("defaults to null/\"\" when the target has no profile row (no crash)", async () => {
    getPublicProfileForViewer.mockResolvedValue({
      id: "u2",
      name: "Gus",
      discriminator: "1337",
      image: null,
      aboutMe: "",
      bannerColor: null,
      statusEmoji: null,
      statusText: "",
      identity: { kind: "human" },
    })
    const res = await GET(req, { params: { userId: "u2" } } as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.statusEmoji).toBeNull()
    expect(body.statusText).toBe("")
  })

  it("returns the bot union with a public owner navigation ref and exact owner flag", async () => {
    getPublicProfileForViewer.mockResolvedValue({
      id: "b1",
      name: "Maia",
      discriminator: "6751",
      image: null,
      aboutMe: "backend",
      bannerColor: null,
      statusEmoji: null,
      statusText: "",
      identity: {
        kind: "bot",
        ownerProfile: { id: "u1", handle: "gus#1813" },
        ownedByViewer: true,
      },
    })
    const res = await GET(req, { params: { userId: "b1" } } as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(expect.objectContaining({
      kind: "bot",
      ownerProfile: { id: "u1", handle: "gus#1813" },
      ownedByViewer: true,
    }))
  })

  it("404s when the joined live target/owner query does not resolve", async () => {
    getPublicProfileForViewer.mockResolvedValue(null)
    const res = await GET(req, { params: { userId: "u2" } } as never)
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(body.error).toBe("user not found")
  })

  it("starts both mutual-server reads concurrently after the joined profile read", async () => {
    let resolveViewer!: (ids: string[]) => void
    let resolveTarget!: (ids: string[]) => void
    const viewer = new Promise<string[]>((resolve) => { resolveViewer = resolve })
    const target = new Promise<string[]>((resolve) => { resolveTarget = resolve })
    listMemberServerIds.mockImplementation((_db: unknown, userId: string) =>
      userId === "u1" ? viewer : target,
    )

    const response = GET(req, { params: { userId: "u2" } } as never)
    await vi.waitFor(() => expect(listMemberServerIds).toHaveBeenCalledTimes(2))
    resolveViewer(["s1", "s2"])
    resolveTarget(["s2", "s3"])

    const res = await response
    expect(res.status).toBe(200)
    expect((await res.json()).mutualServers).toBe(1)
  })
})
