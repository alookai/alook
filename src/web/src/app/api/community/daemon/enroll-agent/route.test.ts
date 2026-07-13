import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockMint = vi.fn()
const mockFindCred = vi.fn()

const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<any>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMachine: {
        mintAgentRunnerKey: (...a: unknown[]) => mockMint(...a),
        findActiveCredentialByBearer: (...a: unknown[]) => mockFindCred(...a),
      },
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
      },
      communityBot: {
        getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a),
      },
    },
  }
})

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/daemon/enroll-agent", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("POST /api/community/daemon/enroll-agent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: happy-path bot exists, owned by u_1, bound to cm_1.
    mockGetUserInternal.mockResolvedValue({
      id: "agent_a",
      isBot: true,
      ownerUserId: "u_1",
      deletedAt: null,
    })
    mockGetBotBinding.mockResolvedValue({ machineId: "cm_1", runtime: "claude" })
  })

  it("returns 200 + runnerKey on happy path", async () => {
    mockFindCred.mockResolvedValue({
      credentialId: "cmk_ok",
      userId: "u_1",
      machineId: "cm_1",
    })
    mockMint.mockResolvedValue({ runnerKey: "crk_new" })
    const res = await POST(req({ agentId: "agent_a" }, { Authorization: "Bearer cmk_ok" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runnerKey: "crk_new", expiresAt: null })
  })

  it("401 without Authorization", async () => {
    const res = await POST(req({ agentId: "x" }))
    expect(res.status).toBe(401)
  })

  it("401 with wrong prefix", async () => {
    const res = await POST(req({ agentId: "x" }, { Authorization: "Bearer cmt_abc" }))
    expect(res.status).toBe(401)
    expect(mockFindCred).not.toHaveBeenCalled()
  })

  it("401 with unknown credential", async () => {
    mockFindCred.mockResolvedValue(null)
    const res = await POST(req({ agentId: "x" }, { Authorization: "Bearer cmk_bad" }))
    expect(res.status).toBe(401)
  })

  it("400 on empty agentId", async () => {
    mockFindCred.mockResolvedValue({
      credentialId: "cmk_ok",
      userId: "u_1",
      machineId: "cm_1",
    })
    const res = await POST(req({ agentId: "" }, { Authorization: "Bearer cmk_ok" }))
    expect(res.status).toBe(400)
  })

  it("400 on malformed body", async () => {
    mockFindCred.mockResolvedValue({
      credentialId: "cmk_ok",
      userId: "u_1",
      machineId: "cm_1",
    })
    const res = await POST(req("not json", { Authorization: "Bearer cmk_ok" }))
    expect(res.status).toBe(400)
  })

  it("404 bot not found — unknown bot id (no such user row)", async () => {
    mockFindCred.mockResolvedValue({
      credentialId: "cmk_ok",
      userId: "u_1",
      machineId: "cm_1",
    })
    mockGetUserInternal.mockResolvedValue(null)
    const res = await POST(req({ agentId: "agent_missing" }, { Authorization: "Bearer cmk_ok" }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "bot not found" })
    expect(mockGetBotBinding).not.toHaveBeenCalled()
    expect(mockMint).not.toHaveBeenCalled()
  })

  it("404 bot not found — soft-deleted bot id (deletedAt set)", async () => {
    mockFindCred.mockResolvedValue({
      credentialId: "cmk_ok",
      userId: "u_1",
      machineId: "cm_1",
    })
    mockGetUserInternal.mockResolvedValue({
      id: "agent_a",
      isBot: true,
      ownerUserId: "u_1",
      deletedAt: "2024-01-01T00:00:00.000Z",
    })
    const res = await POST(req({ agentId: "agent_a" }, { Authorization: "Bearer cmk_ok" }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "bot not found" })
    expect(mockGetBotBinding).not.toHaveBeenCalled()
    expect(mockMint).not.toHaveBeenCalled()
  })

  it("404 bot not found — bot id belongs to a different owner", async () => {
    mockFindCred.mockResolvedValue({
      credentialId: "cmk_ok",
      userId: "u_1",
      machineId: "cm_1",
    })
    mockGetUserInternal.mockResolvedValue({
      id: "agent_a",
      isBot: true,
      ownerUserId: "u_other",
      deletedAt: null,
    })
    const res = await POST(req({ agentId: "agent_a" }, { Authorization: "Bearer cmk_ok" }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "bot not found" })
    expect(mockGetBotBinding).not.toHaveBeenCalled()
    expect(mockMint).not.toHaveBeenCalled()
  })

  it("404 bot not on this machine — binding points at a different machine", async () => {
    mockFindCred.mockResolvedValue({
      credentialId: "cmk_ok",
      userId: "u_1",
      machineId: "cm_1",
    })
    mockGetBotBinding.mockResolvedValue({ machineId: "cm_other", runtime: "claude" })
    const res = await POST(req({ agentId: "agent_a" }, { Authorization: "Bearer cmk_ok" }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "bot not on this machine" })
    expect(mockMint).not.toHaveBeenCalled()
  })
})
