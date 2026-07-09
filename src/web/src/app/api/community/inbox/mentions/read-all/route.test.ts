import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockMarkAllMentionsRead = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    communityMention: {
      markAllMentionsRead: (...args: unknown[]) => mockMarkAllMentionsRead(...args),
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

import { POST } from "./route"

describe("POST /api/community/inbox/mentions/read-all", () => {
  beforeEach(() => vi.clearAllMocks())

  it("marks all mentions read for the current user", async () => {
    mockMarkAllMentionsRead.mockResolvedValue(undefined)
    const res = await POST(new NextRequest("http://localhost/api/community/inbox/mentions/read-all", { method: "POST" }))
    expect(res.status).toBe(200)
    expect(mockMarkAllMentionsRead).toHaveBeenCalledWith({}, "u1")
  })
})
