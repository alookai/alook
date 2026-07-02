import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

// The activate route also broadcasts machine.created — stub that.
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: vi.fn(async () => {}),
}))

const mockActivate = vi.fn()
const mockGetMachine = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<any>("@alook/shared")
  class MockActivateError extends Error {
    constructor(public readonly kind: string, message: string) {
      super(message)
      this.name = "ActivateCredentialError"
    }
  }
  return {
    ...actual,
    queries: {
      communityMachine: {
        activateMachineCredential: (...a: unknown[]) => mockActivate(...a),
        getMachineByIdForUser: (...a: unknown[]) => mockGetMachine(...a),
        ActivateCredentialError: MockActivateError,
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
    },
  }
})

// Retrieve the MockActivateError constructor after mocks have been hoisted.
async function getMockError(): Promise<any> {
  const { queries } = await import("@alook/shared")
  return (queries as any).communityMachine.ActivateCredentialError
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
  beforeEach(() => vi.clearAllMocks())

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
  })

  it("returns 200 + credential/machineId on happy path", async () => {
    mockActivate.mockResolvedValue({
      credential: "cmk_alpha",
      machineId: "cm_alpha",
      userId: "u_1",
    })
    mockGetMachine.mockResolvedValue({ id: "cm_alpha", hostname: "myhost", displayName: "myhost" })
    const res = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_pending" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      credential: "cmk_alpha",
      machineId: "cm_alpha",
      expiresAt: null,
    })
    expect(mockActivate).toHaveBeenCalledWith({}, "cmt_pending", expect.objectContaining({ hostname: "myhost" }))
  })

  it("404 when the token is unknown", async () => {
    const Err = await getMockError()
    mockActivate.mockRejectedValue(new Err("unknown", "unknown token"))
    const res = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_unknown" }))
    expect(res.status).toBe(404)
  })

  it("409 when the token is already revoked / active", async () => {
    const Err = await getMockError()
    mockActivate.mockRejectedValue(new Err("revoked", "revoked"))
    const res = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_r" }))
    expect(res.status).toBe(409)

    mockActivate.mockRejectedValue(new Err("already_active", "already active"))
    const res2 = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_a" }))
    expect(res2.status).toBe(409)
  })

  it("410 when the token is expired", async () => {
    const Err = await getMockError()
    mockActivate.mockRejectedValue(new Err("expired", "expired"))
    const res = await POST(jsonReq(goodBody, { Authorization: "Bearer cmt_old" }))
    expect(res.status).toBe(410)
  })
})
