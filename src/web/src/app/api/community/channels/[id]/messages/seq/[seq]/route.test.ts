import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetChannel = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetMessageByChannelAndSeq = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
      },
      communityMessage: {
        getMessageByChannelAndSeq: (...a: unknown[]) => mockGetMessageByChannelAndSeq(...a),
      },
    },
  }
})

// Dual-actor: crk_ bearer → bot, else human (mirrors the real wrapper).
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    const authz = req?.headers?.get?.("Authorization") ?? ""
    const actor = authz.startsWith("Bearer crk_")
      ? { kind: "bot", userId: "bot_1", ownerUserId: "o_1", machineId: "m_1" }
      : { kind: "human", userId: "u1", email: "u@t.com" }
    return handler(req, { env: { DB: {} }, actor, params })
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

function getReq(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/community/channels/c1/messages/seq/42", { method: "GET", headers })
}
const ctx = (id = "c1", seq = "42") => ({ params: { id, seq } }) as any

describe("GET /api/community/channels/[id]/messages/seq/[seq] — dual-actor seq→id lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "text", parentChannelId: null })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type: "text", parentChannelId: null })
  })

  it("resolves a seq to its message id for a member (single-auth-entry via requireMessageSurfaceAccess)", async () => {
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "m42" })
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "m42" })
    expect(mockGetMessageByChannelAndSeq).toHaveBeenCalledWith({}, { channelId: "c1" }, 42)
  })

  it("404 not_found when the seq has no message in this channel", async () => {
    mockGetMessageByChannelAndSeq.mockResolvedValue(null)
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "not_found" })
  })

  it("unknown channel → 404 at the mask (before the seq lookup, opaque)", async () => {
    mockGetChannel.mockResolvedValue(null) // getChannel probe → not found
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(404)
    expect(mockGetMessageByChannelAndSeq).not.toHaveBeenCalled()
  })

  it("known channel + non-member → 403 (human split preserved)", async () => {
    mockGetChannelForMember.mockResolvedValue(null) // known (getChannel found) but not a member
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(403)
    expect(mockGetMessageByChannelAndSeq).not.toHaveBeenCalled()
  })

  it("invalid seq → 400 before any query", async () => {
    const res = await GET(getReq(), ctx("c1", "0"))
    expect(res.status).toBe(400)
    expect(mockGetChannel).not.toHaveBeenCalled()
  })

  it("bot (crk_) hits the SAME mask (①-C: bot passes requireMessageSurfaceAccess, not skipped)", async () => {
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "m42" })
    const res = await GET(getReq({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(200)
    // The bot went through the same getChannel/getChannelForMember mask (scoped to bot userId).
    expect(mockGetChannelForMember).toHaveBeenCalledWith({}, "c1", "bot_1")
  })
})
