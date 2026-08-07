import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
// Unified actor: a no-`crk_` request falls through to the human withAuth path.
// Mock Better-Auth to "no session" so a no-auth request yields the human-path
// 401 instead of a 503 from unmocked session validation.
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: vi.fn(async () => ({ headers: new Headers(), response: null })) },
  })),
}))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockListAgentFriends = vi.fn()
const mockWsDoFetch = vi.fn()

vi.mock("@/lib/broadcast", () => ({
  wsDoFetch: (...a: unknown[]) => mockWsDoFetch(...a),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityFriendship: { listAgentFriends: (...a: unknown[]) => mockListAgentFriends(...a) },
    },
  }
})

import { GET } from "./route"

const BOT = "bot_zoe"

// Bot arm of GET /api/community/friends/accepted (folds the flat listFriends
// verb's accepted bucket). Bot addresses with no target-user param (self-scope,
// users/me/* family invariant); a no-crk_ request falls to the human withAuth
// arm → 401 via the mocked no-session auth.
function req(headers: Record<string, string> = { Authorization: "Bearer crk_abc" }): NextRequest {
  return new NextRequest("http://localhost/api/community/friends/accepted", {
    method: "GET",
    headers: { ...headers },
  })
}

describe("GET /api/community/friends/accepted — bot arm (folds listFriends accepted bucket)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: BOT })
    mockGetUserInternal.mockResolvedValue({ id: BOT, isBot: true, deletedAt: null, ownerUserId: "owner_1" })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockWsDoFetch.mockResolvedValue({ ok: true, json: async () => ({ online: ["u_alice"] }) })
  })

  it("401 without Authorization", async () => {
    const res = await GET(req({}))
    expect(res.status).toBe(401)
  })

  it("projects the profile-card shape with presence, and never emits isBot", async () => {
    mockListAgentFriends.mockResolvedValue({
      accepted: [
        {
          friendshipId: "fr_1",
          peerUserId: "u_alice",
          name: "Alice",
          discriminator: "0042",
          image: null,
          aboutMe: "hi there",
          statusEmoji: "🎧",
          statusText: "Vibing",
        },
      ],
      pendingOutgoing: [],
      pendingIncoming: [],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain("\"isBot\"")
    const body = JSON.parse(raw)
    expect(body.accepted[0]).toEqual({
      userId: "u_alice",
      handle: "Alice#0042",
      name: "Alice",
      bio: "hi there",
      statusText: "Vibing",
      statusEmoji: "🎧",
      presence: "online",
    })
  })

  it("defaults presence to offline when the peer isn't in the online set", async () => {
    mockWsDoFetch.mockResolvedValue({ ok: true, json: async () => ({ online: [] }) })
    mockListAgentFriends.mockResolvedValue({
      accepted: [
        { friendshipId: "fr_1", peerUserId: "u_alice", name: "Alice", discriminator: "0042", image: null, aboutMe: null, statusEmoji: null, statusText: null },
      ],
      pendingOutgoing: [],
      pendingIncoming: [],
    })
    const res = await GET(req())
    const body = await res.json()
    expect(body.accepted[0].presence).toBe("offline")
  })

  it("returns { accepted: [] } (not null) for a bot with no accepted friends; presence not queried", async () => {
    mockListAgentFriends.mockResolvedValue({ accepted: [], pendingOutgoing: [], pendingIncoming: [] })
    const res = await GET(req())
    const body = await res.json()
    expect(body).toEqual({ accepted: [] })
    expect(mockWsDoFetch).not.toHaveBeenCalled()
  })
})
