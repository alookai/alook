import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

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

import { POST } from "./route"

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/inboxSnapshot", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  })
}

describe("POST /api/community/agent/inboxSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
  })

  it("401 without Authorization", async () => {
    const res = await POST(new NextRequest("http://localhost/api/community/agent/inboxSnapshot", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(mockGetInboxSnapshotForAgent).not.toHaveBeenCalled()
  })

  it("200 with rows plus derived pendingChannels/pendingMessages totals", async () => {
    mockGetInboxSnapshotForAgent.mockResolvedValue([{ channelId: "ch_1" }, { channelId: "ch_2" }])
    mockToInboxRows.mockResolvedValue([
      { channel: "/studio/general", pendingCount: 3, firstPendingSeq: 1, latestSeq: 3, latestSender: "@Alice", flags: [] },
      { channel: "/.dm/Bob", pendingCount: 2, firstPendingSeq: 5, latestSeq: 6, latestSender: "@Bob", flags: ["dm"] },
    ])
    const res = await POST(req({ Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pendingChannels).toBe(2)
    expect(body.pendingMessages).toBe(5)
    expect(body.rows).toHaveLength(2)
    expect(mockGetInboxSnapshotForAgent).toHaveBeenCalledWith(expect.anything(), "bot_1")
  })

  it("200 with empty rows → zeroed totals, no pending unread", async () => {
    mockGetInboxSnapshotForAgent.mockResolvedValue([])
    mockToInboxRows.mockResolvedValue([])
    const res = await POST(req({ Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [], pendingChannels: 0, pendingMessages: 0 })
  })
})
