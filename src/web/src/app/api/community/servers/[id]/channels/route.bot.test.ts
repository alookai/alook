import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
// Unified actor: a request with no `crk_` bearer falls through to the human
// withAuth path. Mock Better-Auth to resolve "no session" so a no-auth request
// yields the human-path 401 ("unauthorized") — the real unified-actor contract —
// instead of a 503 from unmocked session validation.
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: vi.fn(async () => ({ headers: new Headers(), response: null })) },
  })),
}))

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

import { GET } from "./route"

// Bot arm of the dual-actor GET servers/[id]/channels (single-server, folds the
// flat `listChannels` verb's `--server` mode). The bot addresses by
// `?server=<ref>`; the `[id]` path segment is the `resolve` placeholder the
// daemon sends. The all-servers mode (bot omits `server`) lives at the
// collection route `servers/channels` (separate test). `listUserServers` is
// mocked here only to assert this single-server route never calls it.
function req(server: string | undefined, headers: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/community/servers/resolve/channels")
  if (server !== undefined) url.searchParams.set("server", server)
  return new NextRequest(url, { method: "GET", headers: { ...headers } })
}
const ctx = { params: { id: "resolve" } } as unknown as { params: { id: string } }

describe("GET /api/community/servers/[id]/channels — bot arm (folds listChannels --server)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockListCategoriesByServer.mockResolvedValue([])
  })

  it("401 without Authorization", async () => {
    const res = await GET(req("studio"), ctx as never)
    expect(res.status).toBe(401)
  })

  it("400 when the server query param is missing", async () => {
    const res = await GET(req(undefined, { Authorization: "Bearer crk_abc" }), ctx as never)
    expect(res.status).toBe(400)
    expect(mockResolveServerByNameForMember).not.toHaveBeenCalled()
  })

  it("--server <id>: resolves server-side and scopes to that one server", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "studio" }])
    mockListChannelsForMember.mockResolvedValue([{ id: "ch_1", serverId: "srv_1", name: "general", type: "text", categoryId: null }])
    const res = await GET(req("srv_1", { Authorization: "Bearer crk_abc" }), ctx as never)
    expect(res.status).toBe(200)
    expect(mockListUserServers).not.toHaveBeenCalled()
    expect(mockResolveServerByNameForMember).toHaveBeenCalledWith(expect.anything(), "bot_1", "srv_1")
    expect(mockListChannelsForMember).toHaveBeenCalledWith(expect.anything(), "srv_1", "bot_1")
    expect(await res.json()).toEqual({
      groups: [
        {
          category: null,
          channels: [{ ref: "/studio/general", name: "general", type: "text", visibility: "public" }],
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
    const res = await GET(req("srv_1", { Authorization: "Bearer crk_abc" }), ctx as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      groups: [
        {
          category: null,
          channels: [{ ref: "/demo/announcements", name: "announcements", type: "text", visibility: "public" }],
        },
        {
          category: { name: "Ops", private: false },
          channels: [{ ref: "/demo/general", name: "general", type: "text", visibility: "public" }],
        },
        {
          category: { name: "Founders", private: true },
          channels: [{ ref: "/demo/leadership", name: "leadership", type: "text", visibility: "private" }],
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
    const res = await GET(req("srv_1", { Authorization: "Bearer crk_abc" }), ctx as never)
    expect(await res.json()).toEqual({
      groups: [
        {
          category: null,
          channels: [
            { ref: "/studio/general", name: "general", type: "text", visibility: "public" },
            { ref: "/studio/help", name: "help", type: "forum", visibility: "public" },
          ],
        },
      ],
    })
  })

  it("--server matching no server → 404, listChannelsForMember never called", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([])
    const res = await GET(req("Nope", { Authorization: "Bearer crk_abc" }), ctx as never)
    expect(res.status).toBe(404)
    expect(mockListChannelsForMember).not.toHaveBeenCalled()
  })

  it("--server matching 2+ servers → 400 ambiguous, listing candidate ids/names", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([
      { id: "srv_1", name: "Design Studio" },
      { id: "srv_2", name: "Design Studio" },
    ])
    const res = await GET(req("Design Studio", { Authorization: "Bearer crk_abc" }), ctx as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("srv_1")
    expect(body.error).toContain("srv_2")
    expect(mockListChannelsForMember).not.toHaveBeenCalled()
  })

  it("empty channel list → { groups: [] }, not an error", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "studio" }])
    mockListChannelsForMember.mockResolvedValue([])
    const res = await GET(req("srv_1", { Authorization: "Bearer crk_abc" }), ctx as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ groups: [] })
  })
})
