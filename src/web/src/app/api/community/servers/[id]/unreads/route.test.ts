import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockGetMember = vi.fn()
const mockListVisibleChannelIds = vi.fn()
const mockListVisibleChannelIdsForUser = vi.fn()
const mockListEligibleUnreadChannels = vi.fn()
const mockListUnreadForumOpeners = vi.fn()

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
        listVisibleChannelIds: (...args: unknown[]) => mockListVisibleChannelIds(...args),
        listVisibleChannelIdsForUser: (...args: unknown[]) => mockListVisibleChannelIdsForUser(...args),
      },
      communityInbox: {
        ...actual.queries.communityInbox,
        listEligibleUnreadChannels: (...args: unknown[]) => mockListEligibleUnreadChannels(...args),
        listUnreadForumOpeners: (...args: unknown[]) => mockListUnreadForumOpeners(...args),
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
    mockListVisibleChannelIds.mockResolvedValue(["channel_1", "channel_2"])
    mockListVisibleChannelIdsForUser.mockRejectedValue(new Error("cross-server resolver must not run"))
    mockListEligibleUnreadChannels.mockResolvedValue([
      { serverId: "server_1", channelId: "channel_1" },
      { serverId: "server_1", channelId: "channel_2", parentChannelId: "channel_1" },
    ])
    mockListUnreadForumOpeners.mockResolvedValue([])
  })

  it("returns the complete viewer-visible unread id set scoped to the server", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/unreads"),
      { params: { id: "server_1" } } as never,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      channelIds: ["channel_1", "channel_2"],
      childChannels: [{ id: "channel_2", parentChannelId: "channel_1" }],
      stale: false,
    })
    expect(mockListVisibleChannelIds).toHaveBeenCalledWith(expect.anything(), "server_1", "user_1")
    expect(mockListVisibleChannelIdsForUser).not.toHaveBeenCalled()
    expect(mockListEligibleUnreadChannels).toHaveBeenCalledWith(expect.anything(), "user_1", ["channel_1", "channel_2"])
  })

  it("uses the shared readable, cursor, policy, and attention projection on refetch", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/unreads"),
      { params: { id: "server_1" } } as never,
    )

    expect(await response.json()).toMatchObject({ channelIds: ["channel_1", "channel_2"] })
    expect(mockListEligibleUnreadChannels).toHaveBeenCalledOnce()
  })

  it("keeps a forum parent only while its hybrid projection has an unread opener", async () => {
    mockListEligibleUnreadChannels.mockResolvedValue([
      { serverId: "server_1", channelId: "forum_1", parentChannelId: null, type: "forum" },
    ])
    mockListUnreadForumOpeners.mockResolvedValue([{ forumChannelId: "forum_1" }])

    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/unreads"),
      { params: { id: "server_1" } } as never,
    )

    expect(await response.json()).toMatchObject({ channelIds: ["forum_1"] })
    expect(mockListUnreadForumOpeners).toHaveBeenCalledWith(
      expect.anything(),
      "user_1",
      ["forum_1"],
    )
  })

  it("fails closed when the viewer is not a server member", async () => {
    mockGetMember.mockResolvedValue(null)
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/unreads"),
      { params: { id: "server_1" } } as never,
    )

    expect(response.status).toBe(403)
    expect(mockListVisibleChannelIds).not.toHaveBeenCalled()
    expect(mockListEligibleUnreadChannels).not.toHaveBeenCalled()
  })

  it("marks retry-exhausted reads stale instead of caching an empty read set", async () => {
    mockListVisibleChannelIds.mockRejectedValue(new Error("D1_ERROR: database is locked"))
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/unreads"),
      { params: { id: "server_1" } } as never,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ channelIds: [], childChannels: [], stale: true })
  })
})
