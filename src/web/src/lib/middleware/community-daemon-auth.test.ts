import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindActiveCredential = vi.fn()
vi.mock("@alook/shared", () => ({
  queries: {
    communityMachine: {
      findActiveCredentialByBearer: (...a: unknown[]) => mockFindActiveCredential(...a),
    },
  },
}))

import { withCommunityDaemonAuth } from "./community-daemon-auth"

const handler = vi.fn(async (_req: NextRequest, ctx: any) =>
  NextResponse.json({ ok: true, ctx })
)

describe("withCommunityDaemonAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const wrapped = withCommunityDaemonAuth(handler)

  it("rejects when Authorization is missing", async () => {
    const req = new NextRequest("http://localhost/x")
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "missing or malformed Authorization header" })
  })

  it("rejects a wrong prefix (Bearer cmt_ or al_)", async () => {
    for (const bad of ["Bearer cmt_abc", "Bearer al_abc", "Bearer foo"]) {
      const req = new NextRequest("http://localhost/x", { headers: { Authorization: bad } })
      const res = await wrapped(req)
      expect(res.status).toBe(401)
    }
    expect(mockFindActiveCredential).not.toHaveBeenCalled()
  })

  it("rejects when credential lookup returns null", async () => {
    mockFindActiveCredential.mockResolvedValue(null)
    const req = new NextRequest("http://localhost/x", {
      headers: { Authorization: "Bearer cmk_unknown" },
    })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "credential revoked or unknown" })
  })

  it("passes { userId, machineId, credentialId } to the handler on valid credential", async () => {
    mockFindActiveCredential.mockResolvedValue({
      credentialId: "cmk_abc",
      userId: "u_1",
      machineId: "cm_1",
    })
    const req = new NextRequest("http://localhost/x", {
      headers: { Authorization: "Bearer cmk_abc" },
    })
    const res = await wrapped(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ctx: any }
    expect(body.ctx).toMatchObject({
      userId: "u_1",
      machineId: "cm_1",
      credentialId: "cmk_abc",
    })
  })
})
