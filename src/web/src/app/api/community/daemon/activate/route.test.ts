import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockBroadcast = vi.hoisted(() => vi.fn(async () => { }))
const mockForceClose = vi.hoisted(() => vi.fn(async () => { }))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

// The activate route also broadcasts machine.created — stub that.
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: mockBroadcast,
}))

vi.mock("@/lib/community/machine-disconnect", () => ({
  forceCloseCommunityMachinesByDoNames: mockForceClose,
}))

const mockActivate = vi.fn()
const mockGetMachine = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<any>("@alook/shared")
  class MockRotationError extends Error {
    constructor(
      public readonly kind: string,
      message: string,
      public readonly sessionOutcome: "not_committed" | "unknown",
    ) {
      super(message)
      this.name = "MachineSessionRotationError"
    }
  }
  return {
    ...actual,
    queries: {
      communityMachine: {
        getMachineByIdForUser: (...a: unknown[]) => mockGetMachine(...a),
        toSummary: (row: any) => ({
          id: row.id,
          hostname: row.hostname ?? "",
          displayName: row.displayName ?? "",
          platform: "",
          arch: "",
          osRelease: "",
          daemonVersion: "",
          lastSeenAt: null,
          status: "offline",
          availableRuntimes: [],
          createdAt: "t",
          updatedAt: "t",
        }),
      },
      communityMachineSession: {
        transitionMachineSessionEpoch: (...a: unknown[]) => mockActivate(...a),
        MachineSessionRotationError: MockRotationError,
      },
    },
  }
})

// Retrieve the mocked domain error constructor after mocks have been hoisted.
async function getMockError(): Promise<any> {
  const { queries } = await import("@alook/shared")
  return (queries as any).communityMachineSession.MachineSessionRotationError
}

import { POST } from "./route"

function jsonReq(body: object, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/daemon/activate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("POST /api/community/daemon/activate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBroadcast.mockResolvedValue(undefined)
    mockForceClose.mockResolvedValue(undefined)
  })

  const goodBody = {
    hostname: "myhost",
    platform: "darwin",
    arch: "arm64",
  }

  it("401 when Authorization header is missing", async () => {
    const res = await POST(jsonReq(goodBody))
    expect(res.status).toBe(401)
  })

  it("401 when Authorization has wrong prefix", async () => {
    const res = await POST(jsonReq(goodBody, { Authorization: "Bearer cmk_abc" }))
    expect(res.status).toBe(401)
  })

  it("400 on malformed body", async () => {
    const req = new NextRequest("http://localhost/api/community/daemon/activate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer cmt_abc",
      },
      body: "not-json",
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ sessionOutcome: "not_committed" })
  })

  it("returns 200 + credential/machineId on happy path", async () => {
    mockActivate.mockResolvedValue({
      credential: "cmk_alpha",
      machineId: "cm_alpha",
      userId: "u_1",
      revokedDoNames: [],
    })
    mockGetMachine.mockResolvedValue({ id: "cm_alpha", hostname: "myhost", displayName: "myhost" })
    const res = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_pending" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      credential: "cmk_alpha",
      machineId: "cm_alpha",
      expiresAt: null,
      sessionOutcome: "committed",
    })
    expect(mockActivate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        type: "rotate",
        tokenId: "cmt_pending",
        metadata: expect.objectContaining({ hostname: "myhost" }),
        expectedMachineId: undefined,
      }),
    )
  })

  it("404 when the token is unknown", async () => {
    const Err = await getMockError()
    mockActivate.mockRejectedValue(new Err("unknown", "unknown token", "not_committed"))
    const res = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_unknown" }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "unknown token", sessionOutcome: "not_committed" })
  })

  it("409 when the token is already revoked / active", async () => {
    const Err = await getMockError()
    mockActivate.mockRejectedValue(new Err("revoked", "revoked", "unknown"))
    const res = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_r" }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "revoked", sessionOutcome: "unknown" })

    mockActivate.mockRejectedValue(new Err("already_active", "already active", "unknown"))
    const res2 = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_a" }))
    expect(res2.status).toBe(409)
    expect(await res2.json()).toEqual({ error: "already active", sessionOutcome: "unknown" })
  })

  it("410 when the token is expired", async () => {
    const Err = await getMockError()
    mockActivate.mockRejectedValue(new Err("expired", "expired", "not_committed"))
    const res = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_old" }))
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ error: "expired", sessionOutcome: "not_committed" })
  })

  it("returns a committed response without waiting for historical DO close", async () => {
    mockForceClose.mockImplementation(() => new Promise(() => { }))
    mockActivate.mockResolvedValue({
      credential: "cmk_rotated",
      machineId: "cm_alpha",
      userId: "u_1",
      revokedDoNames: ["old-do"],
    })
    mockGetMachine.mockResolvedValue({ id: "cm_alpha", hostname: "myhost", displayName: "myhost" })

    const response = await Promise.race([
      POST(jsonReq(goodBody, { Authorization: "Bearer cmt_pending" })),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50)),
    ])

    expect(response).not.toBe("timed-out")
    expect((response as Response).status).toBe(200)
    expect(await (response as Response).json()).toMatchObject({ sessionOutcome: "committed" })
    await vi.waitFor(() => expect(mockBroadcast).toHaveBeenCalledOnce())
  })

  it("passes expectedMachineId to reconnect activation", async () => {
    mockActivate.mockResolvedValue({
      credential: "cmk_alpha",
      machineId: "cm_alpha",
      userId: "u_1",
      revokedDoNames: ["old-do"],
    })
    mockGetMachine.mockResolvedValue(null)
    const res = await POST(jsonReq(
      { ...goodBody, expectedMachineId: "cm_alpha" },
      { Authorization: "Bearer cmt_pending" },
    ))
    expect(res.status).toBe(200)
    expect(mockActivate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        type: "rotate",
        tokenId: "cmt_pending",
        expectedMachineId: "cm_alpha",
      }),
    )
  })

  it("500 body includes the underlying exception's message for an unhandled failure", async () => {
    mockActivate.mockRejectedValue(new Error("D1_ERROR: database is locked"))
    const res = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_boom" }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: "activate failed: D1_ERROR: database is locked",
    })
  })
})
