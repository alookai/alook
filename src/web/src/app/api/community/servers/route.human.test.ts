import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const mocks = vi.hoisted(() => ({
  listUserServers: vi.fn(),
  listVisibleChannelIdsForUser: vi.fn(),
  listEligibleUnreadChannels: vi.fn(),
  listUnreadMentionSources: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ kind: "db" })) }))
vi.mock("@/lib/community/storage", () => ({
  serverIconUrl: vi.fn((row: { icon?: string | null }) => row.icon ?? null),
}))
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: (...args: any[]) => unknown) =>
    (req: NextRequest) => handler(req, {
      env: { DB: {} },
      actor: { kind: "human", userId: "viewer", email: "viewer@example.test" },
    }),
  rejectBot: vi.fn(() => null),
}))
vi.mock("@/lib/middleware/helpers", () => ({
  writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
  writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityServer: {
        ...actual.queries.communityServer,
        listUserServers: (...args: unknown[]) => mocks.listUserServers(...args),
        listUnreadMentionSources: (...args: unknown[]) => mocks.listUnreadMentionSources(...args),
      },
      communityChannel: {
        ...actual.queries.communityChannel,
        listVisibleChannelIdsForUser: (...args: unknown[]) => mocks.listVisibleChannelIdsForUser(...args),
      },
      communityInbox: {
        ...actual.queries.communityInbox,
        listEligibleUnreadChannels: (...args: unknown[]) => mocks.listEligibleUnreadChannels(...args),
      },
    },
  }
})

import { GET } from "./route"

describe("GET /api/community/servers — human unread seed", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listUserServers.mockResolvedValue([
      { id: "server-a", name: "A", icon: null },
      { id: "server-b", name: "B", icon: null },
    ])
    mocks.listVisibleChannelIdsForUser.mockResolvedValue(["channel-b"])
    mocks.listEligibleUnreadChannels.mockResolvedValue([])
    mocks.listUnreadMentionSources.mockResolvedValue([])
  })

  it("adds exact unread and mention source vectors to every human row", async () => {
    mocks.listEligibleUnreadChannels.mockResolvedValue([{
      serverId: "server-b",
      channelId: "channel-b",
      lastUnreadSeq: 8,
    }])
    mocks.listUnreadMentionSources.mockResolvedValue([{
      serverId: "server-b",
      channelId: "channel-b",
      count: 2,
      lastSeq: 8,
    }, {
      serverId: null,
      channelId: "dm-channel",
      count: 1,
      lastSeq: 4,
    }])

    const response = await GET(new NextRequest("http://localhost/api/community/servers"))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      servers: [
        {
          id: "server-a",
          name: "A",
          icon: null,
          unread: false,
          unreadSources: [],
          mentionSources: [],
        },
        {
          id: "server-b",
          name: "B",
          icon: null,
          unread: true,
          unreadSources: [{ channelId: "channel-b", lastUnreadSeq: 8 }],
          mentionSources: [{ channelId: "channel-b", count: 2, lastSeq: 8 }],
        },
      ],
    })
    expect(mocks.listVisibleChannelIdsForUser).toHaveBeenCalledWith(expect.anything(), "viewer")
    expect(mocks.listEligibleUnreadChannels).toHaveBeenCalledWith(
      expect.anything(),
      "viewer",
      ["channel-b"],
    )
  })

  it("fails the human canonical response when its unread source fails", async () => {
    mocks.listEligibleUnreadChannels.mockRejectedValue(new Error("unread failed"))

    await expect(GET(new NextRequest("http://localhost/api/community/servers")))
      .rejects.toThrow("unread failed")
  })
})
