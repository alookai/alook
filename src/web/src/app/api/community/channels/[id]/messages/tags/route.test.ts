import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })) }))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockRequireChannelAccess = vi.fn()
const mockListDistinctTagsForChannel = vi.fn()

vi.mock("@/lib/community/permissions", () => ({
  requireChannelAccess: (...args: unknown[]) => mockRequireChannelAccess(...args),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMessageTag: {
        ...actual.queries.communityMessageTag,
        listDistinctTagsForChannel: (...args: unknown[]) => mockListDistinctTagsForChannel(...args),
      },
    },
  }
})
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx: any) => handler(req, {
    env: { DB: {} },
    userId: "user_1",
    params: await ctx.params,
  }),
}))

import { GET } from "./route"

const ctx = { params: Promise.resolve({ id: "forum_1" }) } as any

describe("GET /api/community/channels/[id]/messages/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireChannelAccess.mockResolvedValue({ ok: true })
    mockListDistinctTagsForChannel.mockResolvedValue([])
  })

  it("returns an empty message-tag vocabulary for an accessible empty channel", async () => {
    const response = await GET(new Request("http://localhost/api/community/channels/forum_1/messages/tags"), ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tags: [] })
    expect(mockRequireChannelAccess).toHaveBeenCalledWith(expect.anything(), "forum_1", "user_1")
    expect(mockListDistinctTagsForChannel).toHaveBeenCalledWith(expect.anything(), "forum_1")
  })

  it("returns sorted distinct tags from the scoped message resource", async () => {
    mockListDistinctTagsForChannel.mockResolvedValue(["bug", "feature"])
    const response = await GET(new Request("http://localhost/api/community/channels/forum_1/messages/tags"), ctx)
    expect(await response.json()).toEqual({ tags: ["bug", "feature"] })
  })

  it("preserves private-channel access denial without querying tag rows", async () => {
    mockRequireChannelAccess.mockResolvedValue({ ok: false, error: "forbidden", status: 403 })
    const response = await GET(new Request("http://localhost/api/community/channels/forum_1/messages/tags"), ctx)
    expect(response.status).toBe(403)
    expect(mockListDistinctTagsForChannel).not.toHaveBeenCalled()
  })

  it("preserves a missing-channel 404 without querying tag rows", async () => {
    mockRequireChannelAccess.mockResolvedValue({ ok: false, error: "channel not found", status: 404 })
    const response = await GET(new Request("http://localhost/api/community/channels/missing/messages/tags"), ctx)
    expect(response.status).toBe(404)
    expect(mockListDistinctTagsForChannel).not.toHaveBeenCalled()
  })
})
