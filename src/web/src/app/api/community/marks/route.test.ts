import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockMarkMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockRequireChannelMember = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMessageMark: {
        markMessage: (...args: unknown[]) => mockMarkMessage(...args),
      },
      communityMessage: {
        getMessage: (...args: unknown[]) => mockGetMessage(...args),
      },
    },
  }
})

vi.mock("@/lib/community/permissions", () => ({
  requireChannelMember: (...args: unknown[]) => mockRequireChannelMember(...args),
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

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/marks", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("POST /api/community/marks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireChannelMember.mockResolvedValue({ ok: true, value: { id: "c1" } })
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "c1" })
    mockMarkMessage.mockResolvedValue(undefined)
  })

  it("marks a visible message for the current user, self-scoped to ctx.userId", async () => {
    const res = await POST(postReq({ channelId: "c1", messageId: "m1" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockMarkMessage).toHaveBeenCalledWith({}, {
      userId: "u1",
      channelId: "c1",
      messageId: "m1",
    })
  })

  it("is idempotent — a re-mark still returns ok (markMessage no-ops on conflict)", async () => {
    // markMessage uses onConflictDoNothing, so the route does not 409; the
    // second call is a plain ok, unlike pins which 409 on duplicate.
    await POST(postReq({ channelId: "c1", messageId: "m1" }))
    const res = await POST(postReq({ channelId: "c1", messageId: "m1" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("404s when the message does not belong to the claimed channel", async () => {
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "other" })
    const res = await POST(postReq({ channelId: "c1", messageId: "m1" }))
    expect(res.status).toBe(404)
    expect(mockMarkMessage).not.toHaveBeenCalled()
  })

  it("404s when the message does not exist", async () => {
    mockGetMessage.mockResolvedValue(null)
    const res = await POST(postReq({ channelId: "c1", messageId: "m1" }))
    expect(res.status).toBe(404)
    expect(mockMarkMessage).not.toHaveBeenCalled()
  })

  it("forwards the channel-membership gate — a non-member cannot mark", async () => {
    mockRequireChannelMember.mockResolvedValue({ ok: false, error: "forbidden", status: 403 })
    const res = await POST(postReq({ channelId: "c1", messageId: "m1" }))
    expect(res.status).toBe(403)
    expect(mockGetMessage).not.toHaveBeenCalled()
    expect(mockMarkMessage).not.toHaveBeenCalled()
  })

  it("400s on missing messageId or channelId", async () => {
    expect((await POST(postReq({ channelId: "c1" }))).status).toBe(400)
    expect((await POST(postReq({ messageId: "m1" }))).status).toBe(400)
  })
})
