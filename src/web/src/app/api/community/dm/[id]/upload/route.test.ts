import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockRunAttachmentUpload = vi.fn()
const mockRequireDMParticipant = vi.fn()

vi.mock("@/lib/community/upload", () => ({
  runAttachmentUpload: (...a: unknown[]) => mockRunAttachmentUpload(...a),
}))

vi.mock("@/lib/community/permissions", () => ({
  requireDMParticipant: (...a: unknown[]) => mockRequireDMParticipant(...a),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  },
}))

import { POST } from "./route"

function postReq() {
  return new NextRequest("http://localhost/api/community/dm/d1/upload", {
    method: "POST",
  })
}

const ctx = { params: { id: "d1" } } as any

describe("POST /api/community/dm/[id]/upload", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunAttachmentUpload.mockResolvedValue(
      new Response(null, { status: 200 }),
    )
  })

  it("delegates to runAttachmentUpload with kind='dm' + requireDMParticipant", async () => {
    // DM uploads must go through the DM-scoped permission check, which also
    // enforces the block relationship. Any drift away from requireDMParticipant
    // would silently open uploads to a blocked counterpart — pin the binding.
    const req = postReq()
    await POST(req, ctx)
    expect(mockRunAttachmentUpload).toHaveBeenCalledOnce()
    const [passedReq, passedCtx, kind, permCheck] =
      mockRunAttachmentUpload.mock.calls[0]
    expect(passedReq).toBe(req)
    expect(passedCtx).toMatchObject({ userId: "u1", params: { id: "d1" } })
    expect(kind).toBe("dm")
    // Invoke the passed permission-check reference and observe the underlying
    // mock — pins the route to `requireDMParticipant` (a swap to another
    // helper would hit a different mock).
    await (permCheck as (...a: unknown[]) => unknown)("db", "d1", "u1")
    expect(mockRequireDMParticipant).toHaveBeenCalledWith("db", "d1", "u1")
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
