import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetUserByNameAndDiscriminator = vi.fn()
const mockGetBotBinding = vi.fn()
const mockResolveServerByNameForMember = vi.fn()
const mockResolveChannelByNameForMember = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetDM = vi.fn()
const mockGetDMBetween = vi.fn()
const mockIsBlocked = vi.fn()
const mockBumpReadCursor = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
        getUserByNameAndDiscriminator: (...a: unknown[]) => mockGetUserByNameAndDiscriminator(...a),
      },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityFriendship: { isBlocked: (...a: unknown[]) => mockIsBlocked(...a) },
      communityServer: { resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a) },
      communityChannel: {
        resolveChannelByNameForMember: (...a: unknown[]) => mockResolveChannelByNameForMember(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
      },
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
        getDMBetween: (...a: unknown[]) => mockGetDMBetween(...a),
      },
      communityReadState: { bumpReadCursor: (...a: unknown[]) => mockBumpReadCursor(...a) },
    },
  }
})

import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/agent/ack", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("POST /api/community/agent/ack", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "ch_1" }])
    mockGetChannelForMember.mockResolvedValue({ id: "ch_1", serverId: "srv_1", parentChannelId: null })
  })

  it("401 without Authorization", async () => {
    const res = await POST(req({ cursors: [{ channel: "/studio/general", seq: 3 }] }))
    expect(res.status).toBe(401)
  })

  it("400 when cursors is empty (schema requires min 1)", async () => {
    const res = await POST(req({ cursors: [] }, { Authorization: "Bearer crk_abc" }))
    expect(res.status).toBe(400)
  })

  it("400 when a cursor uses seq 0 sentinel", async () => {
    const res = await POST(
      req({ cursors: [{ channel: "/studio/general", seq: 0 }] }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(400)
    expect(mockBumpReadCursor).not.toHaveBeenCalled()
  })

  it("never auto-creates a DM/thread as a side effect — resolves with createDmIfMissing/createThreadIfMissing false", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([])
    const res = await POST(
      req({ cursors: [{ channel: "/studio/general", seq: 3 }] }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(404)
    expect(mockBumpReadCursor).not.toHaveBeenCalled()
  })

  it("404 when bumpReadCursor can't find that seq in the channel", async () => {
    mockBumpReadCursor.mockResolvedValue(null)
    const res = await POST(
      req({ cursors: [{ channel: "/studio/general", seq: 99 }] }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/no message with seq #99/)
  })

  it("fails fast on the first bad cursor, never processing the rest", async () => {
    mockResolveChannelByNameForMember
      .mockResolvedValueOnce([{ id: "ch_1" }])
      .mockResolvedValueOnce([]) // second cursor's channel doesn't resolve
    mockBumpReadCursor.mockResolvedValue({ id: "m_1", createdAt: "t", seq: 3 })
    const res = await POST(
      req(
        {
          cursors: [
            { channel: "/studio/general", seq: 3 },
            { channel: "/studio/missing", seq: 1 },
          ],
        },
        { Authorization: "Bearer crk_abc" }
      )
    )
    expect(res.status).toBe(404)
    expect(mockBumpReadCursor).toHaveBeenCalledTimes(1)
  })

  it("200 { ok: true } advances the cursor for every scope in the request, channel and DM alike", async () => {
    mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "peer_1", discriminator: "0001" })
    mockGetUserInternal.mockImplementation((_db: unknown, id: string) =>
      Promise.resolve(id === "peer_1" ? { id: "peer_1", isBot: false, deletedAt: null } : { isBot: true, deletedAt: null })
    )
    mockGetDMBetween.mockResolvedValue({ id: "dm_1" })
    mockGetDM.mockResolvedValue({ id: "dm_1", user1Id: "bot_1", user2Id: "peer_1", lastMessageAt: null, createdAt: "t" })
    mockIsBlocked.mockResolvedValue(false)
    mockBumpReadCursor.mockResolvedValue({ id: "m_1", createdAt: "t", seq: 1 })
    const res = await POST(
      req(
        {
          cursors: [
            { channel: "/studio/general", seq: 3 },
            { channel: "/.dm/peer#0001", seq: 1 },
          ],
        },
        { Authorization: "Bearer crk_abc" }
      )
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockBumpReadCursor).toHaveBeenCalledTimes(2)
    expect(mockBumpReadCursor).toHaveBeenNthCalledWith(1, expect.anything(), "bot_1", { channelId: "ch_1" }, 3)
    expect(mockBumpReadCursor).toHaveBeenNthCalledWith(2, expect.anything(), "bot_1", { dmConversationId: "dm_1" }, 1)
  })

  it("400 invalid DM handle when a cursor's channel segment has no #0042 tag", async () => {
    const res = await POST(
      req({ cursors: [{ channel: "/.dm/peer_1", seq: 1 }] }, { Authorization: "Bearer crk_abc" })
    )
    expect(res.status).toBe(400)
    expect(mockBumpReadCursor).not.toHaveBeenCalled()
  })
})
