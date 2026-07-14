import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockResolveChannelAccessContext = vi.fn()
const mockRemoveThreadParticipant = vi.fn()
const mockSetThreadParticipantMuted = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
      },
      communityThread: {
        removeThreadParticipant: (...a: unknown[]) => mockRemoveThreadParticipant(...a),
        setThreadParticipantMuted: (...a: unknown[]) => mockSetThreadParticipantMuted(...a),
      },
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

import { DELETE, PATCH } from "./route"

function threadCtx(over: Record<string, unknown> = {}) {
  return {
    channel: { id: "t1", serverId: "s1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", creatorId: "u1" },
    anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
    role: "member", isPrivate: true, isChannelMember: true, isCreator: true,
    ...over,
  }
}
function delReq() {
  return new NextRequest("http://localhost/x", { method: "DELETE" })
}
function patchReq(body: unknown) {
  return new NextRequest("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) })
}

describe("DELETE /channels/[id]/participants/[userId] — leave", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(threadCtx())
    mockRemoveThreadParticipant.mockResolvedValue({ id: "tp1" })
  })

  it("viewer leaves the thread (removes own row)", async () => {
    const res = await DELETE(delReq(), { params: { id: "t1", userId: "u1" } } as any)
    expect(res.status).toBe(204)
    expect(mockRemoveThreadParticipant).toHaveBeenCalledWith(expect.anything(), "t1", "u1")
  })

  it("creator can remove another participant", async () => {
    const res = await DELETE(delReq(), { params: { id: "t1", userId: "u2" } } as any)
    expect(res.status).toBe(204)
  })

  it("non-creator cannot remove someone else (403)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(threadCtx({ isCreator: false }))
    const res = await DELETE(delReq(), { params: { id: "t1", userId: "u2" } } as any)
    expect(res.status).toBe(403)
    expect(mockRemoveThreadParticipant).not.toHaveBeenCalled()
  })
})

describe("PATCH /channels/[id]/participants/[userId] — mute", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(threadCtx({ isCreator: false }))
    mockSetThreadParticipantMuted.mockResolvedValue({ id: "tp1", muted: 1 })
  })

  it("viewer mutes their own participation", async () => {
    const res = await PATCH(patchReq({ muted: true }), { params: { id: "t1", userId: "u1" } } as any)
    expect(res.status).toBe(200)
    expect(mockSetThreadParticipantMuted).toHaveBeenCalledWith(expect.anything(), "t1", "u1", true)
  })

  it("cannot change someone else's mute state (403)", async () => {
    const res = await PATCH(patchReq({ muted: true }), { params: { id: "t1", userId: "u2" } } as any)
    expect(res.status).toBe(403)
    expect(mockSetThreadParticipantMuted).not.toHaveBeenCalled()
  })

  it("400 on a non-boolean muted", async () => {
    const res = await PATCH(patchReq({ muted: "yes" }), { params: { id: "t1", userId: "u1" } } as any)
    expect(res.status).toBe(400)
  })
})
