import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"
import { NextRequest } from "next/server"
import fs from "node:fs"
import path from "node:path"

const mockWsDoWorkerFetch = vi.fn<(...args: unknown[]) => Promise<Response>>()

const mockListMemberUserIds = vi.fn()
const mockGetMember = vi.fn()
const mockFetch = vi.fn<(...args: unknown[]) => Promise<Response>>()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: {
        listMemberUserIds: (...a: unknown[]) => mockListMemberUserIds(...a),
        getMember: (...a: unknown[]) => mockGetMember(...a),
      },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    const env = {
      DB: {},
      WS_DO_WORKER: { fetch: (...a: unknown[]) => mockWsDoWorkerFetch(...a) },
    }
    return handler(req, { env, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

// Stub global fetch — the wsDoFetch helper falls through to fetch(...) when
// the WS_DO_WORKER binding throws.
const originalFetch = globalThis.fetch
beforeEach(() => {
  vi.clearAllMocks()
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

import { GET } from "./route"
import { PRESENCE_MEMBER_CAP } from "@alook/shared"

function getReq() {
  return new NextRequest("http://localhost/api/community/servers/s1/presence", { method: "GET" })
}

const ctx = { params: { id: "s1" } } as any

describe("GET /api/community/servers/[id]/presence", () => {
  it("returns { online, truncated: false, limit: PRESENCE_MEMBER_CAP } identical to pre-refactor", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", serverId: "s1", role: "member" })
    mockListMemberUserIds.mockResolvedValue(["u1", "u2", "u3"])
    mockWsDoWorkerFetch.mockResolvedValue(
      new Response(JSON.stringify({ online: ["u1", "u3"] }), { status: 200 })
    )

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { online: string[]; truncated: boolean; limit: number }
    expect(body.online.sort()).toEqual(["u1", "u3"])
    expect(body.truncated).toBe(false)
    expect(body.limit).toBe(PRESENCE_MEMBER_CAP)
    // Regression: response shape unchanged.
    expect(Object.keys(body).sort()).toEqual(["limit", "online", "truncated"])
    expect(typeof body.limit).toBe("number")
    expect(typeof body.truncated).toBe("boolean")
    expect(Array.isArray(body.online)).toBe(true)
  })

  it("sets truncated=true when member count exceeds PRESENCE_MEMBER_CAP", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", serverId: "s1", role: "member" })
    const ids = Array.from({ length: PRESENCE_MEMBER_CAP + 5 }, (_, i) => `u${i}`)
    mockListMemberUserIds.mockResolvedValue(ids)
    mockWsDoWorkerFetch.mockResolvedValue(
      new Response(JSON.stringify({ online: [] }), { status: 200 })
    )

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { truncated: boolean; limit: number }
    expect(body.truncated).toBe(true)
    expect(body.limit).toBe(PRESENCE_MEMBER_CAP)
  })

  it.each([1, 50, PRESENCE_MEMBER_CAP])(
    "service-binding path: issues exactly one WS_DO_WORKER.fetch call regardless of member count (%i members)",
    async (n) => {
      mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", serverId: "s1", role: "member" })
      const ids = Array.from({ length: n }, (_, i) => `u${i}`)
      mockListMemberUserIds.mockResolvedValue(ids)
      mockWsDoWorkerFetch.mockResolvedValue(
        new Response(JSON.stringify({ online: [] }), { status: 200 })
      )

      const res = await GET(getReq(), ctx)
      expect(res.status).toBe(200)
      expect(mockWsDoWorkerFetch).toHaveBeenCalledTimes(1)
      // Global fetch fallback should NOT fire when binding succeeds.
      expect(mockFetch).not.toHaveBeenCalled()
      const [url, init] = mockWsDoWorkerFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("http://internal/presence/users")
      expect(init.method).toBe("POST")
      expect(JSON.parse(init.body as string)).toEqual({ ids })
    }
  )

  it("HTTP fallback fires when WS_DO_WORKER.fetch throws (binding unavailable)", async () => {
    mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", serverId: "s1", role: "member" })
    mockListMemberUserIds.mockResolvedValue(["u1", "u2"])
    mockWsDoWorkerFetch.mockRejectedValue(new Error("binding missing"))
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ online: ["u1"] }), { status: 200 })
    )

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { online: string[] }
    expect(body.online).toEqual(["u1"])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/presence\/users$/)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ ids: ["u1", "u2"] })
  })

  it("HTTP fallback fires when WS_DO_WORKER.fetch returns non-OK (5xx)", async () => {
    // Regression: pre-refactor, a 5xx from the binding also fell through to
    // the HTTP fallback. Keep that behaviour so a degraded binding doesn't
    // silently drop presence lookups.
    mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", serverId: "s1", role: "member" })
    mockListMemberUserIds.mockResolvedValue(["u1", "u2"])
    mockWsDoWorkerFetch.mockResolvedValue(new Response("boom", { status: 500 }))
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ online: ["u2"] }), { status: 200 })
    )

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { online: string[] }
    expect(body.online).toEqual(["u2"])
    expect(mockWsDoWorkerFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/presence\/users$/)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ ids: ["u1", "u2"] })
  })

  // Guard: the route must go through the shared `wsDoFetch` helper — never
  // reinvent the "try binding → catch → HTTP fallback" ladder inline. If a
  // future edit re-adds a direct WS_DO_WORKER.fetch or DEV_WS_DO_URL, this
  // fails so the review catches the drift.
  it("goes through the new helper (single wsDoFetch import, no ad-hoc fallback)", () => {
    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, "route.ts"),
      "utf8",
    )
    expect(routeSrc).toMatch(/wsDoFetch/)
    expect(routeSrc).not.toMatch(/WS_DO_WORKER/)
    expect(routeSrc).not.toMatch(/DEV_WS_DO_URL/)
  })
})

// Restore global fetch after tests in this file finish so we don't leak the stub.
afterAll(() => {
  globalThis.fetch = originalFetch
})
