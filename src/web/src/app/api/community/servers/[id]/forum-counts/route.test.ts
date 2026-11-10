import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({ member: vi.fn(), visible: vi.fn(), count: vi.fn() }))
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }))
vi.mock("@/lib/middleware/auth", () => ({ humanAuthPolicy: { resolve: async () => ({ context: { env: { DB: {} }, userId: "viewer", email: "viewer@example.com" } }) } }))
vi.mock("@alook/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@alook/shared")>()
  return { ...actual, queries: { ...actual.queries,
    communityMember: { ...actual.queries.communityMember, getMember: mocks.member },
    communityChannel: { ...actual.queries.communityChannel, listServerChannelsForViewer: mocks.visible },
    communityThread: { ...actual.queries.communityThread, countUnarchivedForumPosts: mocks.count },
  } }
})
import { GET } from "./route"
const request = () => new NextRequest("http://localhost/api/community/servers/s1/forum-counts")

describe("forum count authorization", () => {
  beforeEach(() => { vi.clearAllMocks() })
  it("counts only visible forums after the server membership gate", async () => {
    mocks.member.mockResolvedValue({ role: "member" })
    mocks.visible.mockResolvedValue([{ id: "public-forum", type: "forum" }, { id: "joined-private", type: "forum" }, { id: "text", type: "text" }])
    mocks.count.mockResolvedValue({ "public-forum": 12, "joined-private": 0 })
    const response = await GET(request(), { params: { id: "s1" } } as never)
    expect(response.status).toBe(200)
    expect(mocks.visible).toHaveBeenCalledWith(expect.anything(), "s1", "viewer")
    expect(mocks.count).toHaveBeenCalledWith(expect.anything(), "s1", ["public-forum", "joined-private"])
    expect(await response.json()).toEqual({ serverId: "s1", counts: { "public-forum": 12, "joined-private": 0 } })
  })
  it("does not read counts or channels for a nonmember", async () => {
    mocks.member.mockResolvedValue(null)
    const response = await GET(request(), { params: { id: "s1" } } as never)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(mocks.visible).not.toHaveBeenCalled()
    expect(mocks.count).not.toHaveBeenCalled()
  })
})
