import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockGetMember = vi.fn()
const mockListServerChannelsForViewer = vi.fn()
const mockListParticipatingForumThreads = vi.fn()
const mockGetMessagesByIds = vi.fn()
const mockListEligibleUnreadChannels = vi.fn()

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
        listServerChannelsForViewer: (...args: unknown[]) => mockListServerChannelsForViewer(...args),
      },
      communityThread: {
        ...actual.queries.communityThread,
        listParticipatingForumThreads: (...args: unknown[]) => mockListParticipatingForumThreads(...args),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessagesByIds: (...args: unknown[]) => mockGetMessagesByIds(...args),
      },
      communityInbox: {
        ...actual.queries.communityInbox,
        listEligibleUnreadChannels: (...args: unknown[]) => mockListEligibleUnreadChannels(...args),
      },
    },
  }
})
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: any, ctx: any) => handler(req, {
    env: { DB: {} },
    actor: { kind: "human", userId: "user_1", email: "u@example.com" },
    params: ctx.params,
  }),
}))

import { GET } from "./route"

describe("GET /api/community/servers/[id]/channels — human resource", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListEligibleUnreadChannels.mockResolvedValue([])
  })

  it("returns only viewer-visible channel rows after one server membership gate", async () => {
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListServerChannelsForViewer.mockResolvedValue([{ id: "channel_1", serverId: "server_1", name: "general" }])
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/channels"),
      { params: { id: "server_1" } } as never,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ channels: [{ id: "channel_1", serverId: "server_1", name: "general" }] })
    expect(mockListServerChannelsForViewer).toHaveBeenCalledWith(expect.anything(), "server_1", "user_1")
  })

  it("returns recent participating forum threads with opener messages and server-relative expiry", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"))
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListServerChannelsForViewer.mockResolvedValue([
      { id: "forum_visible", serverId: "server_1", name: "Forum", type: "forum" },
      { id: "text_visible", serverId: "server_1", name: "General", type: "text" },
    ])
    const thread = {
      id: "thread_1",
      serverId: "server_1",
      parentChannelId: "forum_visible",
      parentMessageId: "message_1",
      type: "thread",
      activityAt: "2026-08-08T11:00:00.000Z",
    }
    mockListParticipatingForumThreads.mockResolvedValue({ canonical: [thread], retained: thread })
    mockGetMessagesByIds.mockResolvedValue([{ id: "message_1", content: "Current title" }])
    mockListEligibleUnreadChannels.mockResolvedValue([{ channelId: "thread_1" }])

    try {
      const response = await GET(
        new NextRequest("http://localhost/api/community/servers/server_1/channels?type=thread&parentType=forum&participating=true&activeWithin=72h&limitPerParent=5&retainId=thread_1&include=parentMessage"),
        { params: { id: "server_1" } } as never,
      )
      expect(response.status).toBe(200)
      expect(mockListParticipatingForumThreads).toHaveBeenCalledWith(expect.anything(), {
        parentChannelIds: ["forum_visible"],
        userId: "user_1",
        activeAfter: "2026-08-05T12:00:00.000Z",
        limitPerParent: 5,
        retainId: "thread_1",
      })
      expect(await response.json()).toEqual({
        channels: [expect.objectContaining({
          id: "thread_1",
          expiresAt: "2026-08-11T11:00:00.000Z",
          unread: true,
        })],
        canonicalChannels: [expect.objectContaining({
          id: "thread_1",
          expiresAt: "2026-08-11T11:00:00.000Z",
          unread: true,
        })],
        retainedChannel: expect.objectContaining({
          id: "thread_1",
          expiresAt: "2026-08-11T11:00:00.000Z",
          unread: true,
        }),
        included: { parentMessages: [{ id: "message_1", content: "Current title" }] },
        serverNow: "2026-08-08T12:00:00.000Z",
      })
      expect(mockListEligibleUnreadChannels).toHaveBeenCalledWith(expect.anything(), "user_1", ["thread_1"])
      expect(mockGetMessagesByIds).toHaveBeenCalledWith(expect.anything(), ["message_1"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps canonical order intact and builds legacy retain order with binary comparison", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"))
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListServerChannelsForViewer.mockResolvedValue([
      { id: "forum_visible", serverId: "server_1", name: "Forum", type: "forum" },
    ])
    const row = (id: string) => ({
      id,
      serverId: "server_1",
      parentChannelId: "forum_visible",
      parentMessageId: `message_${id}`,
      type: "thread",
      activityAt: "2026-08-08T11:00:00.000Z",
    })
    mockListParticipatingForumThreads.mockResolvedValue({
      canonical: [row("z"), row("a")],
      retained: row("ä"),
    })
    mockGetMessagesByIds.mockResolvedValue([
      { id: "message_z", content: "Z" },
      { id: "message_a", content: "A" },
      { id: "message_ä", content: "Retained" },
    ])

    try {
      const response = await GET(
        new NextRequest("http://localhost/api/community/servers/server_1/channels?type=thread&parentType=forum&participating=true&activeWithin=72h&limitPerParent=2&retainId=ä&include=parentMessage"),
        { params: { id: "server_1" } } as never,
      )
      const body = await response.json() as {
        channels: Array<{ id: string }>
        canonicalChannels: Array<{ id: string }>
      }
      expect(body.canonicalChannels.map((channel) => channel.id)).toEqual(["z", "a"])
      expect(body.channels.map((channel) => channel.id)).toEqual(["ä", "z"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects a partial or oversized sidebar query without reading child threads", async () => {
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListServerChannelsForViewer.mockResolvedValue([])
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/channels?type=thread&limitPerParent=6"),
      { params: { id: "server_1" } } as never,
    )
    expect(response.status).toBe(400)
    expect(mockListParticipatingForumThreads).not.toHaveBeenCalled()
  })
})
