import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockDeleteMention = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    communityMention: {
      deleteMention: (...args: unknown[]) => mockDeleteMention(...args),
    },
  },
}))

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

import { DELETE } from "./route"

describe("DELETE /api/community/inbox/mentions/{id}", () => {
  beforeEach(() => vi.clearAllMocks())

  it("deletes the mention scoped to the current user", async () => {
    mockDeleteMention.mockResolvedValue(undefined)
    const res = await DELETE(new NextRequest("http://localhost/api/community/inbox/mentions/mn1", { method: "DELETE" }), {
      params: { id: "mn1" },
    } as never)
    expect(res.status).toBe(200)
    expect(mockDeleteMention).toHaveBeenCalledWith({}, "u1", "mn1")
  })

  it("400 when mention id is missing from route params", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/community/inbox/mentions/", { method: "DELETE" }), {
      params: {},
    } as never)
    expect(res.status).toBe(400)
    expect(mockDeleteMention).not.toHaveBeenCalled()
  })
})
