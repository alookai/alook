import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreatePairingToken = vi.fn()

vi.mock("@/lib/db", () => ({ getPrimaryDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
  queries: {
    productPlan: actual.queries.productPlan,
    communityMachine: {
      createPairingToken: (...a: unknown[]) => mockCreatePairingToken(...a),
    },
  },
}})

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
import { queries } from "@alook/shared"

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
  it("returns authoritative capacity on quota denial", async () => {
    const capacity = { plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 2, onlineCount: 1 }
    mockCreatePairingToken.mockRejectedValue(new queries.productPlan.MachineLimitReachedError(capacity))
    const response = await POST({} as any, {} as any)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "MACHINE_LIMIT_REACHED", machineCapacity: capacity })
  })
  it("fails closed on unavailable entitlement and propagates unexpected failure", async () => {
    mockCreatePairingToken.mockRejectedValue(new queries.productPlan.ProductEntitlementUnavailableError("machines.max", "entitlement_missing"))
    const response = await POST({} as any, {} as any)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "MACHINE_LIMIT_UNAVAILABLE" })
    mockCreatePairingToken.mockRejectedValue(new Error("database unavailable"))
    await expect(POST({} as any, {} as any)).rejects.toThrow("database unavailable")
  })

})
