import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetChannel = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetMessageByChannelAndSeq = vi.fn()
const mockResolveTargetForMember = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@/lib/community/resolve-ref", () => ({
  resolveTargetForMember: (...a: unknown[]) => mockResolveTargetForMember(...a),
}))

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

// Bot request: crk_ bearer + optional `?ref=` (the `resolve` placeholder sits
// in the path, the real target is the encoded ref in the query).
function botReq(ref?: string, seq = "42") {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : ""
  return new NextRequest(`http://localhost/api/community/channels/resolve/messages/seq/${seq}${q}`, {
    method: "GET",
    headers: { Authorization: "Bearer crk_abc" },
  })
}
const ctxResolve = (seq = "42") => ({ params: { id: "resolve", seq } }) as any

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

  // ── bot arm: ref-in-query (`?ref=`), member-scoped resolve → 404, never 403 ──

  it("bot resolves ref+seq via resolveTargetForMember, then the shared mask", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" })
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "m42" })
    const res = await GET(botReq("/s/general"), ctxResolve())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "m42" })
    // ref went through the member-scoped resolver, keyed on the BOT userId.
    expect(mockResolveTargetForMember).toHaveBeenCalledWith({}, "bot_1", "/s/general", {
      createDmIfMissing: false,
      createThreadIfMissing: false,
      callerKind: "bot",
    })
    // then the same channel-scoped seq lookup + shared mask.
    expect(mockGetChannelForMember).toHaveBeenCalledWith({}, "c1", "bot_1")
  })

  it("①-C: bot ref to an UNREACHABLE channel → 404 (member-scoped resolve, NOT a 403 leak)", async () => {
    // resolveTargetForMember's inner-join yields zero rows for a non-member →
    // it returns 404 BEFORE the mask, so the bot never sees the known-but-non-
    // member 403 that would disclose the channel/message exists.
    mockResolveTargetForMember.mockResolvedValue({ error: 404, message: "channel not found: general" })
    const res = await GET(botReq("/s/general"), ctxResolve())
    expect(res.status).toBe(404)
    expect(mockGetMessageByChannelAndSeq).not.toHaveBeenCalled()
    // the mask is never reached — the 404 is upstream at resolve.
    expect(mockGetChannel).not.toHaveBeenCalled()
  })

  it("bot ref resolves but seq absent in that channel → 404 (channel-scoped, opaque)", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" })
    mockGetMessageByChannelAndSeq.mockResolvedValue(null)
    const res = await GET(botReq("/s/general"), ctxResolve())
    expect(res.status).toBe(404)
  })

  it("bot with no ref falls to the (empty) path id → 400 missing channel id", async () => {
    const res = await GET(botReq(), ctxResolve())
    expect(res.status).toBe(400)
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()
  })
})
