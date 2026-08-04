import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockRunAttachmentUpload = vi.fn()
const mockRequireMessageSurfaceAccess = vi.fn()

vi.mock("@/lib/community/upload", () => ({
  runAttachmentUpload: (...a: unknown[]) => mockRunAttachmentUpload(...a),
}))

vi.mock("@/lib/community/permissions", () => ({
  requireMessageSurfaceAccess: (...a: unknown[]) => mockRequireMessageSurfaceAccess(...a),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  },
}))

import { POST } from "./route"

function postReq() {
  return new NextRequest("http://localhost/api/community/channels/c1/upload", {
    method: "POST",
  })
}

const ctx = { params: { id: "c1" } } as any

describe("POST /api/community/channels/[id]/upload", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunAttachmentUpload.mockResolvedValue(
      new Response(null, { status: 200 }),
    )
  })

  it("delegates to runAttachmentUpload with kind='channel' + requireMessageSurfaceAccess", async () => {
    // The route file is intentionally a one-liner over the shared helper.
    // Its only job is to bind the right (kind, permissionCheck) pair — lock
    // that binding in so accidental swaps between the three upload routes
    // (channel / dm / thread) are caught. The channel-upload gate is now the
    // unified surface dispatch (not bare requireChannelMember): for a DM id it
    // runs the DM block check, closing the P0 where a blocked-but-still-DM-member
    // could upload to a DM through this channel route.
    const req = postReq()
    await POST(req, ctx)
    expect(mockRunAttachmentUpload).toHaveBeenCalledOnce()
    const [passedReq, passedCtx, kind, permCheck] =
      mockRunAttachmentUpload.mock.calls[0]
    expect(passedReq).toBe(req)
    expect(passedCtx).toMatchObject({ userId: "u1", params: { id: "c1" } })
    expect(kind).toBe("channel")
    // The permissionCheck reference is the module export — invoke it and
    // observe that the underlying mock fires, which pins the binding to
    // `requireMessageSurfaceAccess` (a swap to a different permission helper
    // would hit a different mock).
    await (permCheck as (...a: unknown[]) => unknown)("db", "c1", "u1")
    expect(mockRequireMessageSurfaceAccess).toHaveBeenCalledWith("db", "c1", "u1")
  })

  it("returns whatever runAttachmentUpload returns unchanged", async () => {
    const helperResponse = new Response(JSON.stringify({ ok: 1 }), {
      status: 201,
    })
    mockRunAttachmentUpload.mockResolvedValueOnce(helperResponse)
    const res = await POST(postReq(), ctx)
    expect(res).toBe(helperResponse)
  })
})
