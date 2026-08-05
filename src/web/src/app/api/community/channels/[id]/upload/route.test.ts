import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockRunAttachmentUpload = vi.fn()

vi.mock("@/lib/community/upload", () => ({
  runAttachmentUpload: (...a: unknown[]) => mockRunAttachmentUpload(...a),
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

describe("POST /api/community/channels/[id]/upload — unified upload trunk entry", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunAttachmentUpload.mockResolvedValue(new Response(null, { status: 200 }))
  })

  it("delegates to runAttachmentUpload with just (req, ctx) — surface + kind are derived inside", async () => {
    // The route is a one-liner over the shared trunk. Since (A) collapsed the
    // three upload routes to one surface-dispatching entry, the route no longer
    // binds a (kind, permissionCheck) pair — it just forwards; runAttachmentUpload
    // resolves access + derives kind from the dispatch. Lock that it forwards
    // (req, ctx) and passes NO fixed kind/permission (a regression to the old
    // 4-arg binding would show extra args here).
    const req = postReq()
    await POST(req, ctx)
    expect(mockRunAttachmentUpload).toHaveBeenCalledOnce()
    const args = mockRunAttachmentUpload.mock.calls[0]
    expect(args[0]).toBe(req)
    expect(args[1]).toMatchObject({ userId: "u1", params: { id: "c1" } })
    expect(args).toHaveLength(2) // no fixed kind / permissionCheck
  })

  it("returns whatever runAttachmentUpload returns unchanged", async () => {
    const helperResponse = new Response(JSON.stringify({ ok: 1 }), { status: 201 })
    mockRunAttachmentUpload.mockResolvedValueOnce(helperResponse)
    const res = await POST(postReq(), ctx)
    expect(res).toBe(helperResponse)
  })
})
