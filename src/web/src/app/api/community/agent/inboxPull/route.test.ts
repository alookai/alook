import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockListUnreadMessagesForAgent = vi.fn()
const mockToAgentMessages = vi.fn()

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
        listUnreadMessagesForAgent: (...a: unknown[]) => mockListUnreadMessagesForAgent(...a),
        toAgentMessages: (...a: unknown[]) => mockToAgentMessages(...a),
      },
    },
  }
})

import { POST } from "./route"

function req(body?: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/inboxPull", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body } : {}),
  })
}

describe("POST /api/community/agent/inboxPull", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockToAgentMessages.mockImplementation((_db: unknown, rows: unknown[]) => Promise.resolve(rows))
  })

  it("401 without Authorization", async () => {
    const res = await POST(req(undefined))
    expect(res.status).toBe(401)
  })

  it("400 on invalid JSON body", async () => {
    const res = await POST(req("not-json", { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("400 when max is out of the schema's allowed range", async () => {
    const res = await POST(req(JSON.stringify({ max: 0 }), { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("a missing/empty body defaults to {} and uses the default max", async () => {
    mockListUnreadMessagesForAgent.mockResolvedValue([])
    const res = await POST(req(undefined, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(mockListUnreadMessagesForAgent).toHaveBeenCalledWith(expect.anything(), "bot_1", { max: 201 })
  })

  it("hasMore is false and no probe row leaks through when unread count <= max", async () => {
    mockListUnreadMessagesForAgent.mockResolvedValue([{ id: "m_1" }, { id: "m_2" }])
    const res = await POST(req(JSON.stringify({ max: 5 }), { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hasMore).toBe(false)
    expect(body.messages).toHaveLength(2)
    expect(mockListUnreadMessagesForAgent).toHaveBeenCalledWith(expect.anything(), "bot_1", { max: 6 })
  })

  it("hasMore is true and the probe row is trimmed off when unread count > max", async () => {
    mockListUnreadMessagesForAgent.mockResolvedValue([{ id: "m_1" }, { id: "m_2" }, { id: "m_3" }])
    const res = await POST(req(JSON.stringify({ max: 2 }), { Authorization: "Bearer crk_abc" }))
    const body = await res.json()
    expect(body.hasMore).toBe(true)
    expect(body.messages).toHaveLength(2)
  })

  it("caps an oversized max at MAX_PULL (200) before querying", async () => {
    mockListUnreadMessagesForAgent.mockResolvedValue([])
    // Schema itself caps at 200, so this exercises the route's own `Math.min` no-op path at the ceiling.
    const res = await POST(req(JSON.stringify({ max: 200 }), { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(mockListUnreadMessagesForAgent).toHaveBeenCalledWith(expect.anything(), "bot_1", { max: 201 })
  })
})
