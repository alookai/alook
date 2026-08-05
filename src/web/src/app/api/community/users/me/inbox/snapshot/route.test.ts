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
const mockGetInboxSnapshotForAgent = vi.fn()
const mockToInboxRows = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityAgentInbox: {
        getInboxSnapshotForAgent: (...a: unknown[]) => mockGetInboxSnapshotForAgent(...a),
        toInboxRows: (...a: unknown[]) => mockToInboxRows(...a),
      },
    },
  }
})

import { GET } from "./route"

// Bot arm of GET users/me/inbox/snapshot (folds the flat inboxSnapshot verb). A
// GET — pure peek, never advances the read waterline. Self-scoped to the
// voucher's bot (no target-user param). A no-crk_ request falls to the human
// arm → 401.
function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/users/me/inbox/snapshot", {
    method: "GET",
    headers: { ...headers },
  })
}

describe("GET /api/community/users/me/inbox/snapshot — bot arm (folds inboxSnapshot)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
  })

  it("401 without Authorization (human arm, no session)", async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it("returns the per-channel snapshot with pending totals, scoped to the caller's own bot", async () => {
    mockGetInboxSnapshotForAgent.mockResolvedValue({ any: "shape" })
    mockToInboxRows.mockResolvedValue([
      { channelId: "c1", pendingCount: 2 },
      { channelId: "c2", pendingCount: 3 },
    ])
    const res = await GET(req({ Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      rows: [
        { channelId: "c1", pendingCount: 2 },
        { channelId: "c2", pendingCount: 3 },
      ],
      pendingChannels: 2,
      pendingMessages: 5,
    })
    // self-scope: the snapshot query is called with the caller's own bot userId.
    expect(mockGetInboxSnapshotForAgent).toHaveBeenCalledWith(expect.anything(), "bot_1")
  })
})
