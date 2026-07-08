import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetSession = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: {} })),
}))

vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: (...a: unknown[]) => mockGetSession(...a) },
  })),
}))

vi.mock("@/lib/middleware/env", () => ({
  withEnv: vi.fn((handler: any) => async (req: any, ctx?: any) => handler(req, ctx ?? { env: {} })),
}))

import { GET } from "./route"

describe("GET /api/ws/token", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 401 when there is no session", async () => {
    mockGetSession.mockResolvedValue(null)
    const res = await GET(new NextRequest("http://localhost/api/ws/token"))
    expect(res.status).toBe(401)
  })

  it("returns userId and session token for an authenticated caller", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "u_1" },
      session: { token: "sess_tok" },
    })
    const res = await GET(new NextRequest("http://localhost/api/ws/token"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.userId).toBe("u_1")
    expect(body.token).toBe("sess_tok")
  })
})
