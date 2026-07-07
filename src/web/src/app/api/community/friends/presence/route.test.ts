import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"
import { NextRequest } from "next/server"

const mockWsDoWorkerFetch = vi.fn<(...args: unknown[]) => Promise<Response>>()
const mockGetFriendUserIds = vi.fn()
const mockFetch = vi.fn<(...args: unknown[]) => Promise<Response>>()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityFriendship: {
        getFriendUserIds: (...a: unknown[]) => mockGetFriendUserIds(...a),
      },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const env = {
      DB: {},
      WS_DO_WORKER: { fetch: (...a: unknown[]) => mockWsDoWorkerFetch(...a) },
    }
    return handler(req, { env, userId: "u1", email: "u@t.com", params: ctx?.params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

const originalFetch = globalThis.fetch
beforeEach(() => {
  vi.clearAllMocks()
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

import { GET } from "./route"
import { PRESENCE_MEMBER_CAP } from "@alook/shared"

function getReq() {
  return new NextRequest("http://localhost/api/community/friends/presence", { method: "GET" })
}

describe("GET /api/community/friends/presence", () => {
  it("scopes the presence check to the caller's own friends, never client-supplied ids", async () => {
    mockGetFriendUserIds.mockResolvedValue(["f1", "f2", "f3"])
    mockWsDoWorkerFetch.mockResolvedValue(
      new Response(JSON.stringify({ online: ["f1", "f3"] }), { status: 200 })
    )

    const res = await GET(getReq())

    expect(res.status).toBe(200)
    expect(mockGetFriendUserIds).toHaveBeenCalledWith({}, "u1")
    const body = await res.json() as { online: string[] }
    expect(body.online.sort()).toEqual(["f1", "f3"])
    const [url, init] = mockWsDoWorkerFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://internal/presence/users")
    expect(JSON.parse(init.body as string)).toEqual({ ids: ["f1", "f2", "f3"] })
  })

  it("returns { online: [] } without calling wsDoFetch when the caller has zero friends", async () => {
    mockGetFriendUserIds.mockResolvedValue([])

    const res = await GET(getReq())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ online: [] })
    expect(mockWsDoWorkerFetch).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("caps the fan-out at PRESENCE_MEMBER_CAP friend ids", async () => {
    const ids = Array.from({ length: PRESENCE_MEMBER_CAP + 10 }, (_, i) => `f${i}`)
    mockGetFriendUserIds.mockResolvedValue(ids)
    mockWsDoWorkerFetch.mockResolvedValue(
      new Response(JSON.stringify({ online: [] }), { status: 200 })
    )

    await GET(getReq())

    const [, init] = mockWsDoWorkerFetch.mock.calls[0] as [string, RequestInit]
    const sentIds = JSON.parse(init.body as string).ids as string[]
    expect(sentIds).toHaveLength(PRESENCE_MEMBER_CAP)
  })

  it("HTTP fallback fires when WS_DO_WORKER.fetch throws (binding unavailable)", async () => {
    mockGetFriendUserIds.mockResolvedValue(["f1"])
    mockWsDoWorkerFetch.mockRejectedValue(new Error("binding missing"))
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ online: ["f1"] }), { status: 200 })
    )

    const res = await GET(getReq())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ online: ["f1"] })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("returns { online: [] } (not a 500) when wsDoFetch throws entirely", async () => {
    mockGetFriendUserIds.mockResolvedValue(["f1"])
    mockWsDoWorkerFetch.mockRejectedValue(new Error("binding missing"))
    mockFetch.mockRejectedValue(new Error("network down"))

    const res = await GET(getReq())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ online: [] })
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
})
