import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMember = vi.fn()
const mockGetCategory = vi.fn()
const mockCreateChannel = vi.fn()
const mockCreateChannelMember = vi.fn()
const mockFanOutToServerMembers = vi.fn()
const mockFanOutToChannel = vi.fn()
const mockLogAudit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: { getMember: (...a: unknown[]) => mockGetMember(...a) },
      communityCategory: { getCategory: (...a: unknown[]) => mockGetCategory(...a) },
      communityChannel: {
        createChannel: (...a: unknown[]) => mockCreateChannel(...a),
        createChannelMember: (...a: unknown[]) => mockCreateChannelMember(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOutToServerMembers(...a),
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
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

import { POST } from "./route"

const ctx = { params: { id: "s1" } } as any
function req(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/s1/channels", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("POST /servers/[id]/channels", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateChannel.mockResolvedValue({
      id: "c_new", name: "chan", type: "text", categoryId: null, topic: "", position: 0,
      createdAt: "2026-07-12T00:00:00Z",
    })
  })

  it("rejects a plain member creating an uncategorized channel (403, admin-only)", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "member" })
    const res = await POST(req({ name: "chan" }), ctx)
    expect(res.status).toBe(403)
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("admin can create an uncategorized channel; fans out server-wide", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    const res = await POST(req({ name: "chan" }), ctx)
    expect(res.status).toBe(201)
    expect(mockFanOutToServerMembers).toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("rejects a plain member creating in a public category (403)", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "member" })
    mockGetCategory.mockResolvedValue({ id: "cat1", serverId: "s1", private: 0 })
    const res = await POST(req({ name: "chan", categoryId: "cat1" }), ctx)
    expect(res.status).toBe(403)
  })

  it("member CAN create in a private category; seeds a creator member row + channel-scoped fanout", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "member" })
    mockGetCategory.mockResolvedValue({ id: "cat1", serverId: "s1", private: 1 })
    const res = await POST(req({ name: "chan", categoryId: "cat1" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCreateChannelMember).toHaveBeenCalledWith(expect.anything(), {
      channelId: "c_new",
      userId: "u1",
      addedBy: "u1",
    })
    expect(mockFanOutToChannel).toHaveBeenCalled()
    expect(mockFanOutToServerMembers).not.toHaveBeenCalled()
  })

  it("normalizes a spaced name via slugify before creating the channel", async () => {
    // Admin, since an uncategorized channel is admin-only to create.
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    const res = await POST(req({ name: "General Chat" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "General-Chat" }),
    )
  })

  it("returns 400 (and never calls createChannel) when the name is all disallowed characters", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    const res = await POST(req({ name: "###" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("returns 409 when a channel with this name already exists in the server", async () => {
    // Uncategorized create is admin-only.
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    mockCreateChannel.mockRejectedValue(
      Object.assign(new Error("UNIQUE constraint failed: community_channel.server_id, community_channel.name"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      }),
    )

    const res = await POST(req({ name: "general" }), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "a channel with this name already exists" })
    expect(mockFanOutToServerMembers).not.toHaveBeenCalled()
  })

  it("rethrows non-uniqueness errors from createChannel", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", role: "admin" })
    mockCreateChannel.mockRejectedValue(new Error("boom"))
    await expect(POST(req({ name: "general" }), ctx)).rejects.toThrow("boom")
  })
})
