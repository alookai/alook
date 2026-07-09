import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockResolveServerByNameForMember = vi.fn()
const mockListMembers = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityServer: { resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a) },
      communityMember: { listMembers: (...a: unknown[]) => mockListMembers(...a) },
    },
  }
})

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/listMembers", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("POST /api/community/agent/listMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
  })

  it("401 without Authorization", async () => {
    const res = await POST(req({ server: "Design Studio" }))
    expect(res.status).toBe(401)
    expect(mockResolveServerByNameForMember).not.toHaveBeenCalled()
  })

  it("404 when the server name/id doesn't resolve for this bot", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([])
    const res = await POST(req({ server: "Nope" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(404)
    expect(mockListMembers).not.toHaveBeenCalled()
  })

  it("400 with candidate server ids/names baked into the error STRING (not a hint field) when ambiguous", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([
      { id: "srv_1", name: "Design Studio" },
      { id: "srv_2", name: "Design Studio" },
    ])
    const res = await POST(req({ server: "Design Studio" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("srv_1")
    expect(body.error).toContain("srv_2")
    expect("hint" in body).toBe(false)
    expect(mockListMembers).not.toHaveBeenCalled()
  })

  it("200 maps rows to {handle, role, nickname?}, defaulting null role to member and omitting nickname when unset", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "Design Studio" }])
    mockListMembers.mockResolvedValue([
      { userName: "gustavo", discriminator: "4821", role: "owner", nickname: null },
      { userName: "ally", discriminator: "0192", role: null, nickname: "Ally" },
    ])
    const res = await POST(req({ server: "Design Studio" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      members: [
        { handle: "gustavo#4821", role: "owner" },
        { handle: "ally#0192", role: "member", nickname: "Ally" },
      ],
    })
  })

  it("200 resolving by bare server ID as well as by name", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "Design Studio" }])
    mockListMembers.mockResolvedValue([])
    const res = await POST(req({ server: "srv_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(mockResolveServerByNameForMember).toHaveBeenCalledWith(expect.anything(), "bot_1", "srv_1")
    expect(mockListMembers).toHaveBeenCalledWith(expect.anything(), "srv_1")
  })
})
