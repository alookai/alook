import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannel = vi.fn()
const mockGetReadState = vi.fn()
const mockListMessages = vi.fn()
const mockRequireChannelMember = vi.fn()
const mockEnrichMessages = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    withD1Retry: (fn: () => unknown) => fn(),
    queries: {
      communityChannel: {
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
      },
      communityReadState: {
        getReadState: (...a: unknown[]) => mockGetReadState(...a),
      },
      communityMessage: {
        listMessages: (...a: unknown[]) => mockListMessages(...a),
      },
    },
  }
})

vi.mock("@/lib/community/permissions", () => ({
  requireChannelMember: (...a: unknown[]) => mockRequireChannelMember(...a),
}))

vi.mock("@/lib/community/enrich-messages", () => ({
  enrichMessages: (...a: unknown[]) => mockEnrichMessages(...a),
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

import { GET } from "./route"

function call(channelId: string | undefined = "c1") {
  const req = new NextRequest("http://localhost/api/community/channels/c1/bootstrap", { method: "GET" })
  return GET(req, { params: { id: channelId } } as any)
}

describe("GET /api/community/channels/[id]/bootstrap — access gate (BE1)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetReadState.mockResolvedValue(null)
    mockListMessages.mockResolvedValue([])
    mockEnrichMessages.mockResolvedValue({ messages: [], latestSeq: 0 })
  })

  it("happy path: a member with access resolves in ONE query and never probes getChannel", async () => {
    mockRequireChannelMember.mockResolvedValue({ ok: true, value: { id: "c1", serverId: "s1" } })

    const res = await call()

    expect(res.status).toBe(200)
    // The round-trip BE1 saves: the existence probe must NOT run on the hot path.
    expect(mockGetChannel).not.toHaveBeenCalled()
  })

  it("403 when the channel exists but the caller is not a member", async () => {
    mockRequireChannelMember.mockResolvedValue({ ok: false, error: "forbidden", status: 403 })
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })

    const res = await call()

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "forbidden" })
  })

  it("404 when the channel does not exist (ordering preserved over the 403)", async () => {
    mockRequireChannelMember.mockResolvedValue({ ok: false, error: "forbidden", status: 403 })
    mockGetChannel.mockResolvedValue(null)

    const res = await call()

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "channel not found" })
  })
})
