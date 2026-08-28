import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// Bot-path coverage for the UNIFIED server-list route (listServers folded onto
// GET /servers, plan §4/§9 phase 4-5). A `crk_` bearer drives
// withCommunityActor's bot path; GET lists via listUserServers(actor.userId).
// The route returns the SUPERSET (full rows + icon) — the daemon/CLI projects
// each row down to the lean {handle} shape. That daemon-side lean
// projection is asserted by the daemon projection test, NOT here; here we lock
// the ROUTE contract: bot auth works, scoping is by the bot's own membership,
// and the full rows (incl. id+name) are returned.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

// No-`crk_` request falls through to the human withAuth path; mock Better-Auth
// to "no session" so a no-auth request yields the human-path 401 rather than a
// 503 from unmocked session validation.
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: vi.fn(async () => ({ headers: new Headers(), response: null })) },
  })),
}))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockListUserServers = vi.fn()
const mockListEligibleUnreadServerIds = vi.fn()

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
      communityInbox: {
        ...actual.queries.communityInbox,
        listEligibleUnreadServerIds: (...a: unknown[]) => mockListEligibleUnreadServerIds(...a),
      },
    },
  }
})

// serverIconUrl reads the row; keep it a passthrough so we assert on ids/names.
vi.mock("@/lib/community/storage", () => ({
  serverIconUrl: vi.fn(() => null),
}))

import { GET } from "./route"

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/servers", {
    method: "GET",
    headers: { ...headers },
  })
}

describe("GET /api/community/servers — bot path (folded listServers)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockListEligibleUnreadServerIds.mockRejectedValue(new Error("human unread source failed"))
  })

  it("401 without Authorization (no crk_ → human path, no session)", async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(mockListUserServers).not.toHaveBeenCalled()
  })

  it("200 lists servers scoped to the bot's own membership", async () => {
    mockListUserServers.mockResolvedValue([
      { id: "srv_1", name: "Studio", ownerId: "u_owner" },
      { id: "srv_2", name: "Lab" },
    ])
    const res = await GET(req({ Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { servers: Array<{ id: string; name: string }> }
    expect(body.servers.map((s) => ({ id: s.id, name: s.name }))).toEqual([
      { id: "srv_1", name: "Studio" },
      { id: "srv_2", name: "Lab" },
    ])
    // Scoping red line: the bot sees only ITS OWN servers (actor.userId=bot_1).
    expect(mockListUserServers).toHaveBeenCalledWith(expect.anything(), "bot_1")
    expect(mockListEligibleUnreadServerIds).not.toHaveBeenCalled()
    expect(body.servers.every((server) => !("unread" in server))).toBe(true)
  })

  it("200 with an empty list when the bot is in no servers", async () => {
    mockListUserServers.mockResolvedValue([])
    const res = await GET(req({ Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect((await res.json()).servers).toEqual([])
    expect(mockListEligibleUnreadServerIds).not.toHaveBeenCalled()
  })
})
