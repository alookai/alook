import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })) }))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockRequireMessageSurfaceAccess = vi.fn()
const mockGetMessagesByIdsInScope = vi.fn()
const mockGetFirstMessageByChannelIds = vi.fn()
const mockGetDirectChildThreadsByIds = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessagesByIdsInScope: (...args: unknown[]) => mockGetMessagesByIdsInScope(...args),
        getFirstMessageByChannelIds: (...args: unknown[]) => mockGetFirstMessageByChannelIds(...args),
      },
      communityChannel: {
        ...actual.queries.communityChannel,
        getDirectChildThreadsByIds: (...args: unknown[]) => mockGetDirectChildThreadsByIds(...args),
      },
    },
  }
})
vi.mock("@/lib/community/permissions", () => ({ requireMessageSurfaceAccess: (...args: unknown[]) => mockRequireMessageSurfaceAccess(...args) }))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any) => handler(req, { env: { DB: {} }, userId: "user_1" }),
}))
vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

function request(body: unknown) {
  return new NextRequest("http://localhost/api/community/messages/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/community/messages/batch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireMessageSurfaceAccess.mockResolvedValue({ ok: true })
    mockGetMessagesByIdsInScope.mockResolvedValue([{ id: "message_1", channelId: "forum_1" }])
    mockGetFirstMessageByChannelIds.mockResolvedValue([{ id: "reply_1", channelId: "thread_1" }])
    mockGetDirectChildThreadsByIds.mockResolvedValue([{ id: "thread_1" }])
  })

  it("gates the parent once and validates all requested direct children in one query", async () => {
    const response = await POST(request({ channelId: "forum_1", ids: ["message_1"], firstInChannelIds: ["thread_1"] }))

    expect(response.status).toBe(200)
    expect(mockGetMessagesByIdsInScope).toHaveBeenCalledWith(expect.anything(), ["message_1"], { channelId: "forum_1" })
    expect(mockRequireMessageSurfaceAccess).toHaveBeenCalledWith(expect.anything(), "forum_1", "user_1")
    expect(mockRequireMessageSurfaceAccess).toHaveBeenCalledTimes(1)
    expect(mockGetDirectChildThreadsByIds).toHaveBeenCalledWith(expect.anything(), "forum_1", ["thread_1"])
  })

  it("does not query messages when the parent scope is inaccessible", async () => {
    mockRequireMessageSurfaceAccess.mockResolvedValueOnce({ ok: false, status: 404, error: "channel not found" })

    const response = await POST(request({ channelId: "private_forum", ids: ["message_1"] }))

    expect(response.status).toBe(404)
    expect(mockGetMessagesByIdsInScope).not.toHaveBeenCalled()
  })

  it("rejects the entire batch when any id is not a direct child", async () => {
    mockGetDirectChildThreadsByIds.mockResolvedValue([])
    const response = await POST(request({ channelId: "forum_1", firstInChannelIds: ["foreign_thread"] }))
    expect(response.status).toBe(404)
    expect(mockGetFirstMessageByChannelIds).not.toHaveBeenCalled()
  })
})
