import { beforeEach, describe, expect, it, vi } from "vitest"

const mockCreateReconnectPairingToken = vi.fn()
const mockRevokeRunnerKeysForMachine = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", () => ({
  queries: {
    communityMachine: {
      createReconnectPairingToken: (...args: unknown[]) =>
        mockCreateReconnectPairingToken(...args),
      revokeRunnerKeysForMachine: (...args: unknown[]) =>
        mockRevokeRunnerKeysForMachine(...args),
    },
  },
}))

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
})
