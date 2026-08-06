import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockGetMember = vi.fn()
const mockListVisibleChannelIds = vi.fn()
const mockListUnreadChannels = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMember: { getMember: (...args: unknown[]) => mockGetMember(...args) },
      communityChannel: {
        ...actual.queries.communityChannel,
        listVisibleChannelIdsForUser: (...args: unknown[]) => mockListVisibleChannelIds(...args),
      },
      communityInbox: {
        ...actual.queries.communityInbox,
        listUnreadChannels: (...args: unknown[]) => mockListUnreadChannels(...args),
      },
    },
  }
})
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx: any) => handler(req, {
    env: { DB: {} },
    userId: "user_1",
    params: ctx.params,
  }),
}))

import { GET } from "./route"

describe("GET /api/community/servers/[id]/unreads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListVisibleChannelIds.mockResolvedValue(["channel_1", "channel_2", "other_1"])
    mockListUnreadChannels.mockResolvedValue([
      { serverId: "server_1", channelId: "channel_1" },
      { serverId: "server_1", channelId: "channel_2" },
      { serverId: "server_2", channelId: "other_1" },
    ])
  })

  it("returns the complete viewer-visible unread id set scoped to the server", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/unreads"),
      { params: { id: "server_1" } } as never,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ channelIds: ["channel_1", "channel_2"], stale: false })
    expect(mockListUnreadChannels).toHaveBeenCalledWith(expect.anything(), "user_1", ["channel_1", "channel_2", "other_1"])
  })

  it("does not consult notification settings, so server/channel mute cannot hide read-state", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/unreads"),
      { params: { id: "server_1" } } as never,
    )

    expect(await response.json()).toMatchObject({ channelIds: ["channel_1", "channel_2"] })
    expect(mockListUnreadChannels).toHaveBeenCalledOnce()
  })

  it("fails closed when the viewer is not a server member", async () => {
    mockGetMember.mockResolvedValue(null)
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/unreads"),
      { params: { id: "server_1" } } as never,
    )

    expect(response.status).toBe(403)
    expect(mockListVisibleChannelIds).not.toHaveBeenCalled()
    expect(mockListUnreadChannels).not.toHaveBeenCalled()
  })

  it("marks retry-exhausted reads stale instead of caching an empty read set", async () => {
    mockListVisibleChannelIds.mockRejectedValue(new Error("D1_ERROR: database is locked"))
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/unreads"),
      { params: { id: "server_1" } } as never,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ channelIds: [], stale: true })
  })
})
