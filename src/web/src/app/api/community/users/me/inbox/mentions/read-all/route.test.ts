import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockMarkAllMentionsReadWithRevision = vi.fn()
const mockBroadcastToUserSafe = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getPrimaryDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMention: {
        ...actual.queries.communityMention,
        markAllMentionsReadWithRevision: (...args: unknown[]) => mockMarkAllMentionsReadWithRevision(...args),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...args: unknown[]) => mockBroadcastToUserSafe(...args),
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

describe("POST /api/community/users/me/inbox/mentions/read-all", () => {
  beforeEach(() => vi.clearAllMocks())

  it("marks all mentions read for the current user", async () => {
    mockMarkAllMentionsReadWithRevision.mockResolvedValue({ count: 2, changed: true, revision: 7 })
    const res = await POST(new NextRequest("http://localhost/api/community/users/me/inbox/mentions/read-all", { method: "POST" }))
    expect(res.status).toBe(200)
    expect(mockMarkAllMentionsReadWithRevision).toHaveBeenCalledWith({}, "u1")
    expect(mockBroadcastToUserSafe).toHaveBeenCalledWith("u1", expect.objectContaining({
      reason: "mention_read_all",
      revision: 7,
    }))
    await expect(res.json()).resolves.toEqual({ ok: true, count: 2, changed: true, revision: 7 })
  })

  it("returns the current revision without broadcasting a duplicate no-op", async () => {
    mockMarkAllMentionsReadWithRevision.mockResolvedValue({ count: 0, changed: false, revision: 7 })
    const res = await POST(new NextRequest("http://localhost/api/community/users/me/inbox/mentions/read-all", { method: "POST" }))
    await expect(res.json()).resolves.toEqual({ ok: true, count: 0, changed: false, revision: 7 })
    expect(mockBroadcastToUserSafe).not.toHaveBeenCalled()
  })
})
