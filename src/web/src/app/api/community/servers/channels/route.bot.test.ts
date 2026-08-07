import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
// Unified actor: a request with no `crk_` bearer falls through to the human
// withAuth path. Mock Better-Auth to resolve "no session" so a no-auth request
// yields the human-path 401 — but this route's human arm returns a lean 404
// (no all-servers human DTO), so the no-crk_ case here lands on that.
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: vi.fn(async () => ({ headers: new Headers(), response: null })) },
  })),
}))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockListUserServers = vi.fn()
const mockListChannelsForMember = vi.fn()
const mockListCategoriesByServer = vi.fn()

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
      communityCategory: { listCategoriesByServer: (...a: unknown[]) => mockListCategoriesByServer(...a) },
    },
  }
})

import { GET } from "./route"

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/servers/channels", {
    method: "GET",
    headers: { ...headers },
  })
}

// The all-servers channel list: GET servers/channels (collection level). Folds
// the flat `listChannels` verb's no-`--server` mode — fan out across every
// server the bot is in, concatenate groups in listUserServers order.
describe("GET /api/community/servers/channels — bot arm (folds listChannels all-servers)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockListCategoriesByServer.mockResolvedValue([])
  })

  it("401 without Authorization (falls to human arm, no session)", async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(mockListUserServers).not.toHaveBeenCalled()
  })

  it("concatenates groups across every server the bot is in", async () => {
    mockListUserServers.mockResolvedValue([{ id: "srv_1", name: "studio", discriminator: "0042" }, { id: "srv_2", name: "lounge", discriminator: "0042" }])
    mockListChannelsForMember.mockImplementation((_db: unknown, serverId: string) =>
      Promise.resolve(
        serverId === "srv_1"
          ? [{ id: "ch_1", serverId: "srv_1", name: "general", type: "text", categoryId: null }]
          : [{ id: "ch_2", serverId: "srv_2", name: "random", type: "text", categoryId: null }]
      )
    )
    const res = await GET(req({ Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      groups: [
        {
          category: null,
          channels: [{ ref: "/studio#0042/general", name: "general", type: "text", visibility: "public" }],
        },
        {
          category: null,
          channels: [{ ref: "/lounge#0042/random", name: "random", type: "text", visibility: "public" }],
        },
      ],
    })
    expect(mockListUserServers).toHaveBeenCalledTimes(1)
  })

  it("bot in zero servers → { groups: [] }", async () => {
    mockListUserServers.mockResolvedValue([])
    const res = await GET(req({ Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ groups: [] })
    expect(mockListChannelsForMember).not.toHaveBeenCalled()
  })
})
