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

function req(headers: Record<string, string> = { Authorization: "Bearer crk_abc" }): NextRequest {
  return new NextRequest("http://localhost/api/community/friends/pending", {
    method: "GET",
    headers: { ...headers },
  })
}

describe("GET /api/community/friends/pending — bot arm (folds listFriends pending buckets)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: BOT })
    mockGetUserInternal.mockResolvedValue({ id: BOT, isBot: true, deletedAt: null, ownerUserId: "owner_1" })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockWsDoFetch.mockResolvedValue({ ok: true, json: async () => ({ online: ["u_bob"] }) })
  })

  it("returns the two directional buckets as FriendCards with presence", async () => {
    mockListAgentFriends.mockResolvedValue({
      accepted: [],
      pendingIncoming: [
        { friendshipId: "fr_in", peerUserId: "u_bob", name: "Bob", discriminator: "0007", image: null, aboutMe: null, statusEmoji: null, statusText: null },
      ],
      pendingOutgoing: [
        { friendshipId: "fr_out", peerUserId: "u_cara", name: "Cara", discriminator: "0009", image: null, aboutMe: null, statusEmoji: null, statusText: null },
      ],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain("\"isBot\"")
    const body = JSON.parse(raw)
    expect(body.pendingIncoming[0]).toMatchObject({ userId: "u_bob", handle: "Bob#0007", presence: "online" })
    expect(body.pendingOutgoing[0]).toMatchObject({ userId: "u_cara", handle: "Cara#0009", presence: "offline" })
    // Bot arm does NOT emit the accepted bucket (that's friends/accepted).
    expect("accepted" in body).toBe(false)
  })

  it("empty pending → both buckets [], presence not queried", async () => {
    mockListAgentFriends.mockResolvedValue({ accepted: [], pendingIncoming: [], pendingOutgoing: [] })
    const res = await GET(req())
    expect(await res.json()).toEqual({ pendingIncoming: [], pendingOutgoing: [] })
    expect(mockWsDoFetch).not.toHaveBeenCalled()
  })

  it("401 without Authorization", async () => {
    const res = await GET(req({}))
    expect(res.status).toBe(401)
  })
})
