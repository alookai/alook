import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreatePairingToken = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", () => ({
  queries: {
    communityMachine: {
      createPairingToken: (...a: unknown[]) => mockCreatePairingToken(...a),
    },
  },
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (_req: any, ctx?: any) =>
    handler(_req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params: ctx?.params }),
  ),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
  }
})

import { POST } from "./route"

describe("POST /api/community/machines/pair", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreatePairingToken.mockResolvedValue({
      tokenId: "pair_tok_1",
      expiresAt: "2026-07-09T00:00:00.000Z",
    })
  })

  it("creates a pairing token for the authed user", async () => {
    const res = await POST({} as any, {} as any)
    expect(res.status).toBe(200)
    expect(mockCreatePairingToken).toHaveBeenCalledWith(expect.anything(), "u1")
    const body = await res.json()
    expect(body).toEqual({ tokenId: "pair_tok_1", expiresAt: "2026-07-09T00:00:00.000Z" })
  })
})
