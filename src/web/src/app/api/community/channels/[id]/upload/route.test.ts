import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockRunAttachmentUpload = vi.fn()
const mockRequireChannelMember = vi.fn()

vi.mock("@/lib/community/upload", () => ({
  runAttachmentUpload: (...a: unknown[]) => mockRunAttachmentUpload(...a),
}))

vi.mock("@/lib/community/permissions", () => ({
  requireChannelMember: (...a: unknown[]) => mockRequireChannelMember(...a),
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

  it("delegates to runAttachmentUpload with kind='channel' + requireChannelMember", async () => {
    // The route file is intentionally a one-liner over the shared helper.
    // Its only job is to bind the right (kind, permissionCheck) pair — lock
    // that binding in so accidental swaps between the three upload routes
    // (channel / dm / thread) are caught.
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
    // `requireChannelMember` (a swap to a different permission helper
    // would hit a different mock).
    await (permCheck as (...a: unknown[]) => unknown)("db", "c1", "u1")
    expect(mockRequireChannelMember).toHaveBeenCalledWith("db", "c1", "u1")
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
