import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockListForYouEvents = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityInbox: {
        listForYouEvents: (...args: unknown[]) => mockListForYouEvents(...args),
      },
    },
  }
})

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

describe("GET /api/community/inbox/foryou", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns events from the query", async () => {
    const event = {
      eventKey: "mention:m1",
      kind: "mention",
      serverId: "s1",
      serverName: "Server 1",
      channelId: "c1",
      channelName: "general",
      messageId: "m1",
      authorId: "u2",
      authorName: "Alice",
      authorAvatar: "A",
      preview: "hi",
      createdAt: "2026-06-25T10:00:00Z",
    }
    mockListForYouEvents.mockResolvedValue([event])

    const res = await GET(new NextRequest("http://localhost/api/community/inbox/foryou"))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.events).toEqual([event])
    expect(body.limit).toBeGreaterThan(0)
    expect(mockListForYouEvents).toHaveBeenCalledWith({}, "u1", { limit: body.limit })
  })

  it("returns empty events array when none", async () => {
    mockListForYouEvents.mockResolvedValue([])
    const res = await GET(new NextRequest("http://localhost/api/community/inbox/foryou"))
    const body = await res.json()
    expect(body.events).toEqual([])
  })

  it("honours the limit query param when within bounds", async () => {
    mockListForYouEvents.mockResolvedValue([])
    const res = await GET(new NextRequest("http://localhost/api/community/inbox/foryou?limit=25"))
    const body = await res.json()
    expect(body.limit).toBe(25)
    expect(mockListForYouEvents).toHaveBeenCalledWith({}, "u1", { limit: 25 })
  })

  it("clamps an over-cap limit to MAX_INBOX_PAGE_SIZE", async () => {
    mockListForYouEvents.mockResolvedValue([])
    const res = await GET(new NextRequest("http://localhost/api/community/inbox/foryou?limit=99999"))
    const body = await res.json()
    expect(body.limit).toBe(200) // MAX_INBOX_PAGE_SIZE
  })
})
