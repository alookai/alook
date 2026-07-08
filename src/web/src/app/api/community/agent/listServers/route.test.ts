import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockListUserServers = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityServer: { listUserServers: (...a: unknown[]) => mockListUserServers(...a) },
    },
  }
})

import { POST } from "./route"

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/listServers", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  })
}

describe("POST /api/community/agent/listServers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
  })

  it("401 without Authorization", async () => {
    const res = await POST(new NextRequest("http://localhost/api/community/agent/listServers", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(mockListUserServers).not.toHaveBeenCalled()
  })

  it("200 maps rows to { id, name } only, dropping other fields", async () => {
    mockListUserServers.mockResolvedValue([
      { id: "srv_1", name: "Studio", ownerId: "u_owner", secretStuff: "nope" },
      { id: "srv_2", name: "Lab" },
    ])
    const res = await POST(req({ Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      servers: [
        { id: "srv_1", name: "Studio" },
        { id: "srv_2", name: "Lab" },
      ],
    })
    expect(mockListUserServers).toHaveBeenCalledWith(expect.anything(), "bot_1")
  })

  it("200 with an empty list when the bot is in no servers", async () => {
    mockListUserServers.mockResolvedValue([])
    const res = await POST(req({ Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ servers: [] })
  })
})
