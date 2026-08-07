import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })) }))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockRequireMessageSurfaceAccess = vi.fn()
const mockGetDirectChildThreadsByIds = vi.fn()
const mockListParticipantsForChannels = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityChannel: {
        ...actual.queries.communityChannel,
        getDirectChildThreadsByIds: (...args: unknown[]) => mockGetDirectChildThreadsByIds(...args),
      },
      communityThread: {
        ...actual.queries.communityThread,
        listParticipantsForChannels: (...args: unknown[]) => mockListParticipantsForChannels(...args),
      },
    },
  }
})
vi.mock("@/lib/community/permissions", () => ({ requireMessageSurfaceAccess: (...args: unknown[]) => mockRequireMessageSurfaceAccess(...args) }))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any) => handler(req, { env: { DB: {} }, userId: "user_1" }),
}))

import { POST } from "./route"

function request(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/participants/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/community/channels/participants/batch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireMessageSurfaceAccess.mockResolvedValue({ ok: true })
    mockGetDirectChildThreadsByIds.mockResolvedValue([{ id: "thread_1" }, { id: "thread_2" }])
    mockListParticipantsForChannels.mockResolvedValue([])
  })

  it("gates one parent and validates the whole direct-child set in one query", async () => {
    const response = await POST(request({ parentChannelId: "forum_1", channelIds: ["thread_1", "thread_2"] }))
    expect(response.status).toBe(200)
    expect(mockRequireMessageSurfaceAccess).toHaveBeenCalledTimes(1)
    expect(mockGetDirectChildThreadsByIds).toHaveBeenCalledWith(expect.anything(), "forum_1", ["thread_1", "thread_2"])
    expect(mockListParticipantsForChannels).toHaveBeenCalledWith(expect.anything(), ["thread_1", "thread_2"])
  })

  it("rejects all results when one requested id belongs elsewhere", async () => {
    mockGetDirectChildThreadsByIds.mockResolvedValue([{ id: "thread_1" }])
    const response = await POST(request({ parentChannelId: "forum_1", channelIds: ["thread_1", "foreign"] }))
    expect(response.status).toBe(404)
    expect(mockListParticipantsForChannels).not.toHaveBeenCalled()
  })

  it("passes an explicit capped preview limit without changing the legacy absent-limit call", async () => {
    const response = await POST(request({
      parentChannelId: "forum_1",
      channelIds: ["thread_1", "thread_2"],
      limitPerChannel: 5,
    }))
    expect(response.status).toBe(200)
    expect(mockListParticipantsForChannels).toHaveBeenCalledWith(
      expect.anything(),
      ["thread_1", "thread_2"],
      5,
    )
  })

  it.each([0, -1, 11, 1.5, "5"])("rejects invalid present limitPerChannel %s", async (limitPerChannel) => {
    const response = await POST(request({
      parentChannelId: "forum_1",
      channelIds: ["thread_1", "thread_2"],
      limitPerChannel,
    }))
    expect(response.status).toBe(400)
    expect(mockListParticipantsForChannels).not.toHaveBeenCalled()
  })
})
