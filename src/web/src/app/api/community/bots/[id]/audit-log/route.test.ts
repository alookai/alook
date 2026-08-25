import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockListOwnedBotActivityEvents = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBotAuditLog: {
        listOwnedBotActivityEvents: (...a: unknown[]) => mockListOwnedBotActivityEvents(...a),
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
    expect(mockListOwnedBotActivityEvents).not.toHaveBeenCalled()
  })

  it("returns 404 when the one owner-scoped query finds no live owned bot", async () => {
    mockListOwnedBotActivityEvents.mockResolvedValue(null)
    const res = await GET(req(), ctx("b1"))
    expect(res.status).toBe(404)
    expect(mockListOwnedBotActivityEvents).toHaveBeenCalledTimes(1)
    expect(mockListOwnedBotActivityEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ botId: "b1", ownerUserId: "u1" }),
    )
  })

  it("returns rows + a null nextCursor when fewer than `limit` results come back", async () => {
    mockListOwnedBotActivityEvents.mockResolvedValue([
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

  it("returns 200 with an empty page for an owned bot with no events", async () => {
    mockListOwnedBotActivityEvents.mockResolvedValue([])
    const res = await GET(req("?limit=5"), ctx("b1"))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ events: [], nextCursor: null })
    expect(mockListOwnedBotActivityEvents).toHaveBeenCalledTimes(1)
  })

  it("round-trips a canonical tool_call row: name is lowercased, target survives", async () => {
    mockListOwnedBotActivityEvents.mockResolvedValue([
      {
        id: "bae_1",
        botId: "b1",
        sessionId: null,
        launchId: null,
        kind: "tool_call",
        payload: JSON.stringify({ name: "read", target: "AGENTS.md" }),
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    ])
    const res = await GET(req(), ctx("b1"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: Array<{ payload: { name: string; target?: string } }> }
    expect(body.events[0]!.payload.name).toBe("read")
    expect(body.events[0]!.payload.target).toBe("AGENTS.md")
  })

  it("returns a composite nextCursor when the page fills to the limit", async () => {
    const rows = Array.from({ length: 2 }).map((_, i) => ({
      id: `bae_${i}`,
      botId: "b1",
      sessionId: null,
      launchId: null,
      kind: "tool_call",
      payload: JSON.stringify({ name: "Read" }),
      createdAt: `2025-01-01T00:00:0${i}.000Z`,
    }))
    mockListOwnedBotActivityEvents.mockResolvedValue(rows)
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
    mockListOwnedBotActivityEvents.mockResolvedValue([])
    await GET(
      req("?beforeCreatedAt=2025-01-01T00:00:00.000Z&beforeId=bae_x&limit=25"),
      ctx("b1"),
    )
    expect(mockListOwnedBotActivityEvents).toHaveBeenCalledWith(
      expect.anything(),
      {
        botId: "b1",
        ownerUserId: "u1",
        beforeCreatedAt: "2025-01-01T00:00:00.000Z",
        beforeId: "bae_x",
        limit: 25,
      },
    )
  })

  it("returns a parsed {from,to} payload for a model_changed row (guards parseAuditLogPayload's default)", async () => {
    mockListOwnedBotActivityEvents.mockResolvedValue([
      {
        id: "bae_m",
        botId: "b1",
        sessionId: null,
        launchId: null,
        kind: "model_changed",
        payload: JSON.stringify({ from: "claude-opus-4-6", to: "claude-sonnet-4-6" }),
        createdAt: "2026-07-26T00:00:00.000Z",
      },
    ])
    const res = await GET(req(), ctx("b1"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: Array<{ kind: string; payload: unknown }> }
    expect(body.events[0]!.kind).toBe("model_changed")
    expect(body.events[0]!.payload).toEqual({ from: "claude-opus-4-6", to: "claude-sonnet-4-6" })
  })

  it("caps limit at 100 and floors it at 1 (defends against unbounded page requests)", async () => {
    mockListOwnedBotActivityEvents.mockResolvedValue([])
    await GET(req("?limit=99999"), ctx("b1"))
    expect(mockListOwnedBotActivityEvents).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 100 }),
    )
    await GET(req("?limit=0"), ctx("b1"))
    // 0 → falls back to default (50) via the || fallback.
    expect(mockListOwnedBotActivityEvents).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 50 }),
    )
  })
})
