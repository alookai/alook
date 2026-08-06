import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })) }))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockRequireMessageSurfaceAccess = vi.fn()
const mockGetMessagesByIdsInScope = vi.fn()
const mockListTagsForMessages = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMessage: { ...actual.queries.communityMessage, getMessagesByIdsInScope: (...args: unknown[]) => mockGetMessagesByIdsInScope(...args) },
      communityMessageTag: { ...actual.queries.communityMessageTag, listTagsForMessages: (...args: unknown[]) => mockListTagsForMessages(...args) },
    },
  }
})
vi.mock("@/lib/community/permissions", () => ({ requireMessageSurfaceAccess: (...args: unknown[]) => mockRequireMessageSurfaceAccess(...args) }))
vi.mock("@/lib/middleware/auth", () => ({ withAuth: (handler: any) => async (req: any) => handler(req, { env: { DB: {} }, userId: "user_1" }) }))
vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

describe("POST /api/community/messages/tags/batch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireMessageSurfaceAccess.mockResolvedValue({ ok: true })
    mockGetMessagesByIdsInScope.mockResolvedValue([{ id: "message_1" }])
    mockListTagsForMessages.mockResolvedValue([{ messageId: "message_1", tag: "bug" }])
  })

  it("reads tags only for message ids selected inside the authorized channel scope", async () => {
    const response = await POST(new NextRequest("http://localhost/api/community/messages/tags/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: "forum_1", messageIds: ["message_1", "foreign_message"] }),
    }))

    expect(response.status).toBe(200)
    expect(mockGetMessagesByIdsInScope).toHaveBeenCalledWith(expect.anything(), ["message_1", "foreign_message"], { channelId: "forum_1" })
    expect(mockListTagsForMessages).toHaveBeenCalledWith(expect.anything(), ["message_1"])
  })
})
