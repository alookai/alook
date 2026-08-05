import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: vi.fn(async () => ({ headers: new Headers(), response: null })) },
  })),
}))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockListBlocked = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityFriendship: { listBlocked: (...a: unknown[]) => mockListBlocked(...a) },
    },
  }
})

// The human arm delegates through the real withAuth; mock it so a human ctx is
// injected without exercising Better-Auth.
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u_owner", email: "o@t.com", params })
  }),
}))

import { GET } from "./route"

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/friends/blocked", {
    method: "GET",
    headers: { ...headers },
  })
}

describe("GET /api/community/friends/blocked", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_zoe" })
    mockGetUserInternal.mockResolvedValue({ id: "bot_zoe", isBot: true, deletedAt: null, ownerUserId: "owner_1" })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
  })

  it("bot → 403 BEFORE any blocked query (owner-only, zero existence leak)", async () => {
    const res = await GET(req({ Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(403)
    // reject-before-query: the blocked list is never read for a bot caller.
    expect(mockListBlocked).not.toHaveBeenCalled()
  })

  it("human → the blocked list", async () => {
    mockListBlocked.mockResolvedValue([
      { id: "bk_1", blockedUserId: "u_x", blockedName: "X", blockedImage: null },
    ])
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.blocked).toEqual([
      { id: "bk_1", userId: "u_x", name: "X", avatar: expect.any(String) },
    ])
  })
})
