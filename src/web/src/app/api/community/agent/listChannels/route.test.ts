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
const mockListChannelsForMember = vi.fn()

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
      communityChannel: { listChannelsForMember: (...a: unknown[]) => mockListChannelsForMember(...a) },
    },
  }
})

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/listChannels", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("POST /api/community/agent/listChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
  })

  it("401 without Authorization", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/community/agent/listChannels", { method: "POST", body: "{}" })
    )
    expect(res.status).toBe(401)
  })

  it("400 on a payload that fails schema validation", async () => {
    const res = await POST(req({ server: "" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("empty body defaults to {} — lists channels across every server the bot is in", async () => {
    mockListUserServers.mockResolvedValue([{ id: "srv_1" }, { id: "srv_2" }])
    mockListChannelsForMember.mockImplementation((_db: unknown, serverId: string) =>
      Promise.resolve(serverId === "srv_1" ? [{ id: "ch_1", serverId: "srv_1", name: "general" }] : [{ id: "ch_2", serverId: "srv_2", name: "random" }])
    )
    const res = await POST(
      new NextRequest("http://localhost/api/community/agent/listChannels", {
        method: "POST",
        headers: { Authorization: "Bearer crk_abc" },
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      channels: [
        { id: "ch_1", serverId: "srv_1", name: "general", kind: "channel" },
        { id: "ch_2", serverId: "srv_2", name: "random", kind: "channel" },
      ],
    })
    expect(mockListUserServers).toHaveBeenCalledTimes(1)
  })

  it("with server provided: scopes to that one server, skips listUserServers", async () => {
    mockListChannelsForMember.mockResolvedValue([{ id: "ch_1", serverId: "srv_1", name: "general" }])
    const res = await POST(req({ server: "srv_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(mockListUserServers).not.toHaveBeenCalled()
    expect(mockListChannelsForMember).toHaveBeenCalledWith(expect.anything(), "srv_1", "bot_1")
    expect(await res.json()).toEqual({
      channels: [{ id: "ch_1", serverId: "srv_1", name: "general", kind: "channel" }],
    })
  })
})
