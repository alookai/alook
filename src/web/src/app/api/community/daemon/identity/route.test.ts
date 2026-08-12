import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindActiveCredential = vi.fn()
vi.mock("@alook/shared", () => ({
  withD1Retry: (fn: () => Promise<unknown>) => fn(),
  queries: {
    communityMachine: {
      findActiveCredentialByBearer: (...args: unknown[]) => mockFindActiveCredential(...args),
    },
  },
}))

import { GET } from "./route"

function request(authorization?: string): NextRequest {
  return new NextRequest("http://localhost/api/community/daemon/identity", {
    headers: authorization ? { authorization } : undefined,
  })
}

describe("GET /api/community/daemon/identity", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns only the authenticated machine id", async () => {
    mockFindActiveCredential.mockResolvedValue({
      credentialId: "cred_1",
      userId: "user_1",
      machineId: "machine_1",
    })
    const response = await GET(request("Bearer cmk_valid"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ machineId: "machine_1" })
  })

  it("rejects missing, pairing, and unknown credentials", async () => {
    expect((await GET(request())).status).toBe(401)
    expect((await GET(request("Bearer cmt_pairing"))).status).toBe(401)
    mockFindActiveCredential.mockResolvedValue(null)
    expect((await GET(request("Bearer cmk_foreign"))).status).toBe(401)
  })
})
