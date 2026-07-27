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
const mockResolveServerByNameForMember = vi.fn()
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
      communityServer: {
        listUserServers: (...a: unknown[]) => mockListUserServers(...a),
        resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a),
      },
      communityChannel: { listChannelsForMember: (...a: unknown[]) => mockListChannelsForMember(...a) },
      communityCategory: { listCategoriesByServer: (...a: unknown[]) => mockListCategoriesByServer(...a) },
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
    mockListCategoriesByServer.mockResolvedValue([])
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

  it("empty body defaults to {} — concatenates groups across every server the bot is in", async () => {
    mockListUserServers.mockResolvedValue([{ id: "srv_1", name: "studio" }, { id: "srv_2", name: "lounge" }])
    mockListChannelsForMember.mockImplementation((_db: unknown, serverId: string) =>
      Promise.resolve(
        serverId === "srv_1"
          ? [{ id: "ch_1", serverId: "srv_1", name: "general", type: "text", categoryId: null }]
          : [{ id: "ch_2", serverId: "srv_2", name: "random", type: "text", categoryId: null }]
      )
    )
    const res = await POST(
      new NextRequest("http://localhost/api/community/agent/listChannels", {
        method: "POST",
        headers: { Authorization: "Bearer crk_abc" },
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      groups: [
        {
          category: null,
          channels: [{ name: "general", type: "text", visibility: "public", id: "ch_1", serverId: "srv_1" }],
        },
        {
          category: null,
          channels: [{ name: "random", type: "text", visibility: "public", id: "ch_2", serverId: "srv_2" }],
        },
      ],
    })
    expect(mockListUserServers).toHaveBeenCalledTimes(1)
    expect(mockResolveServerByNameForMember).not.toHaveBeenCalled()
  })

  it("--server <id>: resolves server-side and scopes to that one server", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "studio" }])
    mockListChannelsForMember.mockResolvedValue([{ id: "ch_1", serverId: "srv_1", name: "general", type: "text", categoryId: null }])
    const res = await POST(req({ server: "srv_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(mockListUserServers).not.toHaveBeenCalled()
    expect(mockResolveServerByNameForMember).toHaveBeenCalledWith(expect.anything(), "bot_1", "srv_1")
    expect(mockListChannelsForMember).toHaveBeenCalledWith(expect.anything(), "srv_1", "bot_1")
    expect(await res.json()).toEqual({
      groups: [
        {
          category: null,
          channels: [{ name: "general", type: "text", visibility: "public", id: "ch_1", serverId: "srv_1" }],
        },
      ],
    })
  })

  it("channels bucketed into their category groups; null-category emitted first; empty groups dropped", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "demo" }])
    mockListChannelsForMember.mockResolvedValue([
      { id: "ch_1", serverId: "srv_1", name: "announcements", type: "text", categoryId: null, position: 0 },
      { id: "ch_2", serverId: "srv_1", name: "general", type: "text", categoryId: "cat_ops", position: 1 },
      { id: "ch_3", serverId: "srv_1", name: "leadership", type: "text", categoryId: "cat_founders", position: 2 },
    ])
    mockListCategoriesByServer.mockResolvedValue([
      { id: "cat_ops", name: "Ops", position: 0, private: 0 },
      { id: "cat_founders", name: "Founders", position: 1, private: 1 },
      { id: "cat_empty", name: "Empty", position: 2, private: 0 },
    ])
    const res = await POST(req({ server: "srv_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      groups: [
        {
          category: null,
          channels: [{ name: "announcements", type: "text", visibility: "public", id: "ch_1", serverId: "srv_1" }],
        },
        {
          category: { name: "Ops", private: false, id: "cat_ops" },
          channels: [{ name: "general", type: "text", visibility: "public", id: "ch_2", serverId: "srv_1" }],
        },
        {
          category: { name: "Founders", private: true, id: "cat_founders" },
          channels: [{ name: "leadership", type: "text", visibility: "private", id: "ch_3", serverId: "srv_1" }],
        },
      ],
    })
  })

  it("a forum-type channel is reported with type:'forum'; a plain channel with type:'text'", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "studio" }])
    mockListChannelsForMember.mockResolvedValue([
      { id: "ch_1", serverId: "srv_1", name: "general", type: "text", categoryId: null },
      { id: "ch_2", serverId: "srv_1", name: "help", type: "forum", categoryId: null },
    ])
    const res = await POST(req({ server: "srv_1" }, { Authorization: "Bearer crk_abc" }))
    expect(await res.json()).toEqual({
      groups: [
        {
          category: null,
          channels: [
            { name: "general", type: "text", visibility: "public", id: "ch_1", serverId: "srv_1" },
            { name: "help", type: "forum", visibility: "public", id: "ch_2", serverId: "srv_1" },
          ],
        },
      ],
    })
  })

  it("--server matching no server → 404, listChannelsForMember never called", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([])
    const res = await POST(req({ server: "Nope" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(404)
    expect(mockListChannelsForMember).not.toHaveBeenCalled()
  })

  it("--server matching 2+ servers → 400 ambiguous, listing candidate ids/names", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([
      { id: "srv_1", name: "Design Studio" },
      { id: "srv_2", name: "Design Studio" },
    ])
    const res = await POST(req({ server: "Design Studio" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("srv_1")
    expect(body.error).toContain("srv_2")
    expect(mockListChannelsForMember).not.toHaveBeenCalled()
  })

  it("empty channel list → { groups: [] }, not an error", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "studio" }])
    mockListChannelsForMember.mockResolvedValue([])
    const res = await POST(req({ server: "srv_1" }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ groups: [] })
  })
})
