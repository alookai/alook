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
const mockGetUserPublic = vi.fn()
const mockGetUserByNameAndDiscriminator = vi.fn()
const mockGetBotBinding = vi.fn()
const mockIsBlocked = vi.fn()
const mockSendRequest = vi.fn()
const mockEnsureSibling = vi.fn()
const mockBroadcastToUser = vi.fn(async () => undefined)
const mockLogAudit = vi.fn()

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}))
vi.mock("@/lib/community/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/audit")>("@/lib/community/audit")
  return { ...actual, logAudit: (...a: unknown[]) => mockLogAudit(...a) }
})

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
        getUserPublic: (...a: unknown[]) => mockGetUserPublic(...a),
        getUserByNameAndDiscriminator: (...a: unknown[]) => mockGetUserByNameAndDiscriminator(...a),
      },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityFriendship: {
        isBlocked: (...a: unknown[]) => mockIsBlocked(...a),
        sendRequest: (...a: unknown[]) => mockSendRequest(...a),
        ensureSiblingBotFriendship: (...a: unknown[]) => mockEnsureSibling(...a),
      },
    },
  }
})

import { POST } from "./route"

const BOT = "bot_zoe"
const OWNER = "owner_bob"

function req(body: unknown, headers: Record<string, string> = { Authorization: "Bearer crk_abc" }): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/friendRequest", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("POST /api/community/agent/friendRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: OWNER, machineId: "m_1", agentId: BOT })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    // getUserInternal is called by the auth middleware (bot) AND the route
    // (target). Route by id.
    mockGetUserInternal.mockImplementation(async (_db: unknown, id: string) => {
      if (id === BOT) return { id: BOT, isBot: true, deletedAt: null, ownerUserId: OWNER }
      return null
    })
    mockGetUserPublic.mockResolvedValue({ id: OWNER, name: "Bob", discriminator: "0001" })
    mockIsBlocked.mockResolvedValue(false)
  })

  it("401 without Authorization", async () => {
    const res = await POST(req({ username: "Alice#0042" }, {}))
    expect(res.status).toBe(401)
  })

  it("bot→human happy path: 200 pending with a hint naming the owner", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "u_alice" })
    mockGetUserInternal.mockImplementation(async (_db: unknown, id: string) => {
      if (id === BOT) return { id: BOT, isBot: true, deletedAt: null, ownerUserId: OWNER }
      if (id === "u_alice") return { id: "u_alice", isBot: false, deletedAt: null, ownerUserId: null }
      return null
    })
    mockSendRequest.mockResolvedValue({
      kind: "created",
      friendship: { id: "fr_1" },
      supersededIds: [],
      broadcasts: [{ userId: OWNER, event: { type: "community:dm.new_message" } }],
    })
    const res = await POST(req({ username: "Alice#0042" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("pending")
    expect(body.friendshipId).toBe("fr_1")
    expect(body.hint).toContain("Bob")
    expect(mockBroadcastToUser).toHaveBeenCalled()
  })

  it("owner target: 409 already_friends, sendRequest never called", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: OWNER })
    const res = await POST(req({ username: "Bob#0001" }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("already_friends")
    expect(mockSendRequest).not.toHaveBeenCalled()
  })

  it("sibling bot target: auto-accepts, 200 accepted with hint null", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "bot_yara" })
    mockGetUserInternal.mockImplementation(async (_db: unknown, id: string) => {
      if (id === BOT) return { id: BOT, isBot: true, deletedAt: null, ownerUserId: OWNER }
      if (id === "bot_yara") return { id: "bot_yara", isBot: true, deletedAt: null, ownerUserId: OWNER }
      return null
    })
    mockEnsureSibling.mockResolvedValue({ blocked: false, friendshipId: "fr_sib", wasCreated: true })
    const res = await POST(req({ username: "Yara#0042" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ friendshipId: "fr_sib", status: "accepted", hint: null })
    expect(mockSendRequest).not.toHaveBeenCalled()
  })

  it("sibling bot target with a blocked row: 403 blocked", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "bot_yara" })
    mockGetUserInternal.mockImplementation(async (_db: unknown, id: string) => {
      if (id === BOT) return { id: BOT, isBot: true, deletedAt: null, ownerUserId: OWNER }
      if (id === "bot_yara") return { id: "bot_yara", isBot: true, deletedAt: null, ownerUserId: OWNER }
      return null
    })
    mockEnsureSibling.mockResolvedValue({ blocked: true })
    const res = await POST(req({ username: "Yara#0042" }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe("blocked")
  })

  it("self target: 400", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: BOT })
    const res = await POST(req({ username: "Zoe#0042" }))
    expect(res.status).toBe(400)
  })

  it("unknown user: 404", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue(null)
    const res = await POST(req({ username: "Nobody#0000" }))
    expect(res.status).toBe(404)
  })

  it("malformed handle (no #tag): 400", async () => {
    const res = await POST(req({ username: "not-a-tag" }))
    expect(res.status).toBe(400)
    expect(mockGetUserByNameAndDiscriminator).not.toHaveBeenCalled()
  })

  it("missing username: 400", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })

  it("logs BOT_FRIEND_REQUEST_SUPERSEDED for each row the request superseded", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "u_alice" })
    mockGetUserInternal.mockImplementation(async (_db: unknown, id: string) => {
      if (id === BOT) return { id: BOT, isBot: true, deletedAt: null, ownerUserId: OWNER }
      if (id === "u_alice") return { id: "u_alice", isBot: false, deletedAt: null, ownerUserId: null }
      return null
    })
    mockSendRequest.mockResolvedValue({
      kind: "created",
      friendship: { id: "fr_new" },
      supersededIds: ["fr_old"],
      broadcasts: [],
    })
    await POST(req({ username: "Alice#0042" }))
    const superseded = mockLogAudit.mock.calls.find(
      (c) => (c[1] as { action: string }).action === "community.bot.friend_request_superseded",
    )
    expect(superseded).toBeDefined()
    expect((superseded![1] as { targetId: string }).targetId).toBe("fr_old")
  })

  it("propagates a sendRequest 'already friends' as 409 already_friends", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "u_alice" })
    mockGetUserInternal.mockImplementation(async (_db: unknown, id: string) => {
      if (id === BOT) return { id: BOT, isBot: true, deletedAt: null, ownerUserId: OWNER }
      if (id === "u_alice") return { id: "u_alice", isBot: false, deletedAt: null, ownerUserId: null }
      return null
    })
    mockSendRequest.mockRejectedValue(new Error("already friends"))
    const res = await POST(req({ username: "Alice#0042" }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("already_friends")
  })
})
