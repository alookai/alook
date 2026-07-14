import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetBotOwnedBy = vi.fn()
const mockListBotActivityEvents = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBot: {
        getBotOwnedBy: (...a: unknown[]) => mockGetBotOwnedBy(...a),
      },
      communityBotAuditLog: {
        listBotActivityEvents: (...a: unknown[]) => mockListBotActivityEvents(...a),
      },
    },
  }
})

let isAuthed = true

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    if (!isAuthed) {
      const { NextResponse } = require("next/server")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, {
      env: { DB: {} },
      userId: "u1",
      email: "u@t.com",
      params,
    })
  },
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

function req(qs = "") {
  const url = `http://localhost/api/community/bots/b1/audit-log${qs}`
  return new NextRequest(url, { method: "GET" })
}
function ctx(id?: string) {
  return { params: Promise.resolve(id ? { id } : {}) } as any
}

describe("GET /api/community/bots/[id]/audit-log", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
  })

  it("returns 401 for anonymous callers", async () => {
    isAuthed = false
    const res = await GET(req(), ctx("b1"))
    expect(res.status).toBe(401)
    expect(mockGetBotOwnedBy).not.toHaveBeenCalled()
  })

  it("returns 404 when the bot is missing or not owned by the session user (getBotOwnedBy filters both)", async () => {
    mockGetBotOwnedBy.mockResolvedValue(null)
    const res = await GET(req(), ctx("b1"))
    expect(res.status).toBe(404)
    expect(mockGetBotOwnedBy).toHaveBeenCalledWith(expect.anything(), "b1", "u1")
    expect(mockListBotActivityEvents).not.toHaveBeenCalled()
  })

  it("returns rows + a null nextCursor when fewer than `limit` results come back", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1" })
    mockListBotActivityEvents.mockResolvedValue([
      {
        id: "bae_1",
        botId: "b1",
        sessionId: null,
        launchId: null,
        kind: "tool_call",
        payload: JSON.stringify({ name: "Read" }),
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    ])
    const res = await GET(req(), ctx("b1"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[]; nextCursor: unknown }
    expect(body.events).toEqual([
      {
        id: "bae_1",
        kind: "tool_call",
        payload: { name: "Read" },
        sessionId: null,
        launchId: null,
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    ])
    expect(body.nextCursor).toBe(null)
  })

  it("returns a composite nextCursor when the page fills to the limit", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1" })
    const rows = Array.from({ length: 2 }).map((_, i) => ({
      id: `bae_${i}`,
      botId: "b1",
      sessionId: null,
      launchId: null,
      kind: "tool_call",
      payload: JSON.stringify({ name: "Read" }),
      createdAt: `2025-01-01T00:00:0${i}.000Z`,
    }))
    mockListBotActivityEvents.mockResolvedValue(rows)
    const res = await GET(req("?limit=2"), ctx("b1"))
    const body = (await res.json()) as { nextCursor: { beforeCreatedAt: string; beforeId: string } | null }
    // Composite cursor uses the LAST row (oldest in the newest-first page) so
    // the next page picks up strictly older events.
    expect(body.nextCursor).toEqual({
      beforeCreatedAt: "2025-01-01T00:00:01.000Z",
      beforeId: "bae_1",
    })
  })

  it("forwards beforeCreatedAt + beforeId to the query for cursor pagination", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1" })
    mockListBotActivityEvents.mockResolvedValue([])
    await GET(
      req("?beforeCreatedAt=2025-01-01T00:00:00.000Z&beforeId=bae_x&limit=25"),
      ctx("b1"),
    )
    expect(mockListBotActivityEvents).toHaveBeenCalledWith(
      expect.anything(),
      {
        botId: "b1",
        beforeCreatedAt: "2025-01-01T00:00:00.000Z",
        beforeId: "bae_x",
        limit: 25,
      },
    )
  })

  it("caps limit at 100 and floors it at 1 (defends against unbounded page requests)", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1" })
    mockListBotActivityEvents.mockResolvedValue([])
    await GET(req("?limit=99999"), ctx("b1"))
    expect(mockListBotActivityEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 100 }),
    )
    await GET(req("?limit=0"), ctx("b1"))
    // 0 → falls back to default (50) via the || fallback.
    expect(mockListBotActivityEvents).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 50 }),
    )
  })
})
