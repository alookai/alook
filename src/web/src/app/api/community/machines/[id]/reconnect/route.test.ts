import { beforeEach, describe, expect, it, vi } from "vitest"

const mockCreateReconnectPairingToken = vi.fn()
const mockRevokeRunnerKeysForMachine = vi.fn()

vi.mock("@/lib/db", () => ({ getPrimaryDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
  queries: {
    productPlan: actual.queries.productPlan,
    communityMachine: {
      createReconnectPairingToken: (...args: unknown[]) =>
        mockCreateReconnectPairingToken(...args),
      revokeRunnerKeysForMachine: (...args: unknown[]) =>
        mockRevokeRunnerKeysForMachine(...args),
    },
  },
}})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) =>
    handler(req, {
      env: { DB: {} },
      userId: "u_1",
      email: "u@example.com",
      params: ctx?.params,
    }),
}))

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"
import { queries } from "@alook/shared"

describe("POST /api/community/machines/[id]/reconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateReconnectPairingToken.mockResolvedValue({
      tokenId: "cmt_reconnect",
      expiresAt: "2026-08-18T12:00:00.000Z",
    })
  })

  it("mints a bound token without disrupting runner keys or the current epoch", async () => {
    const response = await POST({} as any, { params: { id: "cm_abcdefgh" } } as any)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      tokenId: "cmt_reconnect",
      expiresAt: "2026-08-18T12:00:00.000Z",
    })
    expect(mockCreateReconnectPairingToken).toHaveBeenCalledWith(
      {},
      "u_1",
      "cm_abcdefgh",
    )
    expect(mockRevokeRunnerKeysForMachine).not.toHaveBeenCalled()
  })

  it("maps a cross-owner machine to 404", async () => {
    mockCreateReconnectPairingToken.mockRejectedValue(
      new Error("createReconnectPairingToken: machine not owned by user"),
    )

    const response = await POST({} as any, { params: { id: "cm_other" } } as any)
    expect(response.status).toBe(404)
  })
  it("returns authoritative capacity on quota denial", async () => {
    const capacity = { plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 2, onlineCount: 1 }
    mockCreateReconnectPairingToken.mockRejectedValue(new queries.productPlan.MachineLimitReachedError(capacity))
    const response = await POST({} as any, { params: { id: "cm_abcdefgh" } } as any)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "MACHINE_LIMIT_REACHED", machineCapacity: capacity })
  })
  it("fails closed on unavailable entitlement and propagates unexpected failure", async () => {
    mockCreateReconnectPairingToken.mockRejectedValue(new queries.productPlan.ProductEntitlementUnavailableError("machines.max", "entitlement_missing"))
    const response = await POST({} as any, { params: { id: "cm_abcdefgh" } } as any)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "MACHINE_LIMIT_UNAVAILABLE" })
    mockCreateReconnectPairingToken.mockRejectedValue(new Error("database unavailable"))
    await expect(POST({} as any, { params: { id: "cm_abcdefgh" } } as any)).rejects.toThrow("database unavailable")
  })

})
