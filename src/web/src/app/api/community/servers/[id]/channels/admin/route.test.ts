import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  getMember: vi.fn(),
  listDirectory: vi.fn(),
  getPrimaryDb: vi.fn(() => ({})),
  kind: "human" as "human" | "bot",
}))

vi.mock("@/lib/db", () => ({ getPrimaryDb: mocks.getPrimaryDb }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMember: { getMember: mocks.getMember },
      communityChannel: { listServerChannelDirectoryForAdmin: mocks.listDirectory },
    },
  }
})
vi.mock("@/lib/middleware/community-actor", async () => {
  const actual = await vi.importActual<typeof import("@/lib/middleware/community-actor")>("@/lib/middleware/community-actor")
  return {
    ...actual,
    withCommunityActor: (handler: any) => (req: any, ctx: any) => handler(req, {
      env: { DB: {} }, actor: { kind: mocks.kind, userId: "viewer" }, params: ctx?.params,
    }),
  }
})

import { GET } from "./route"

const request = () => new NextRequest("http://localhost/api/community/servers/s1/channels/admin")
const context = (id = "s1") => ({ params: { id } }) as never

describe("GET server admin channel directory", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.kind = "human"
    mocks.listDirectory.mockResolvedValue([])
  })

  it.each(["admin", "owner"])("permits %s and returns only the directory response, without caching", async (role) => {
    mocks.getMember.mockResolvedValue({ role })
    const channels = [{
      id: "private", name: "private", type: "forum", category: { id: "group", name: "PRIVATE", private: true },
      creator: { name: "Alice", handle: "Alice#0042" }, createdAt: "2026-10-01T00:00:00.000Z",
    }]
    mocks.listDirectory.mockResolvedValue(channels)
    const response = await GET(request(), context())
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(await response.json()).toEqual({ channels })
    expect(mocks.getPrimaryDb).toHaveBeenCalledWith({})
    expect(mocks.getMember).toHaveBeenCalledWith(expect.anything(), "s1", "viewer")
    expect(mocks.listDirectory).toHaveBeenCalledWith(expect.anything(), "s1", "viewer")
  })

  it.each(["member", null, "unknown"])("rejects role %s before reading any channel metadata", async (role) => {
    mocks.getMember.mockResolvedValue({ role })
    const response = await GET(request(), context())
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "admin permission required" })
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("rejects an outsider or an admin requesting a different server", async () => {
    mocks.getMember.mockImplementation((_db, serverId) => Promise.resolve(serverId === "s1" ? { role: "admin" } : null))
    const response = await GET(request(), context("s2"))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "not a member of this server" })
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("rejects bots before looking up a server", async () => {
    mocks.kind = "bot"
    const response = await GET(request(), context())
    expect(response.status).toBe(403)
    expect(mocks.getPrimaryDb).not.toHaveBeenCalled()
    expect(mocks.getMember).not.toHaveBeenCalled()
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("rejects a missing server id", async () => {
    const response = await GET(request(), { params: {} } as never)
    expect(response.status).toBe(400)
    expect(mocks.getMember).not.toHaveBeenCalled()
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })
})
