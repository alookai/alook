import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockDismissMentionWithRevision = vi.fn()
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
        dismissMentionWithRevision: (...args: unknown[]) => mockDismissMentionWithRevision(...args),
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

import { DELETE } from "./route"

describe("DELETE /api/community/users/me/inbox/mentions/{id}", () => {
  beforeEach(() => vi.clearAllMocks())

  it("deletes the mention scoped to the current user", async () => {
    // The query returns the number of rows affected; a real hit returns 1.
    mockDismissMentionWithRevision.mockResolvedValue({ changed: true, revision: 4 })
    const res = await DELETE(new NextRequest("http://localhost/api/community/users/me/inbox/mentions/mn1", { method: "DELETE" }), {
      params: { id: "mn1" },
    } as never)
    expect(res.status).toBe(200)
    expect(mockDismissMentionWithRevision).toHaveBeenCalledWith({}, "u1", "mn1")
    expect(mockBroadcastToUserSafe).toHaveBeenCalledWith("u1", expect.objectContaining({
      reason: "mention_dismiss",
      revision: 4,
    }))
    await expect(res.json()).resolves.toEqual({ ok: true, changed: true, revision: 4 })
  })

  it("404 when the mention does not exist or belongs to another user", async () => {
    mockDismissMentionWithRevision.mockResolvedValue({ changed: false, revision: 4 })
    const res = await DELETE(new NextRequest("http://localhost/api/community/users/me/inbox/mentions/mn1", { method: "DELETE" }), {
      params: { id: "mn1" },
    } as never)
    expect(res.status).toBe(404)
  })

  it("400 when mention id is missing from route params", async () => {
    const res = await DELETE(new NextRequest("http://localhost/api/community/users/me/inbox/mentions/", { method: "DELETE" }), {
      params: {},
    } as never)
    expect(res.status).toBe(400)
    expect(mockDismissMentionWithRevision).not.toHaveBeenCalled()
  })
})
