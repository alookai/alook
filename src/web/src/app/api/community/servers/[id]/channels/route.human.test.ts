import { BUSINESS_SCHEMA_VERSION, CommunityChannelResourceSchema, CommunityForumSidebarEnvelopeSchema } from "@alook/shared"
import { channelResourceFixture, messageResourceFixture, serverResourceFixture, fullResourceBundleFixture } from "@/test/community-resource-fixtures"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockReadResourceBundle = vi.fn()
vi.mock("@/lib/community/attention-resources.server", () => ({ readCommunityResourceBundle: (...args: unknown[]) => mockReadResourceBundle(...args) }))
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
        getMessagesByIdsInChannels: (...args: unknown[]) => mockGetMessagesByIds(...args),
      },
      communityInbox: {
        ...actual.queries.communityInbox,
        listEligibleUnreadChannels: (...args: unknown[]) => mockListEligibleUnreadChannels(...args),
      },
    },
  }
})
vi.mock("@/lib/middleware/community-actor", () => ({
  communityActorPolicy: () => ({ resolve: async (req: any) => ({ context: { env: { DB: {} }, actor: { kind: "human", userId: "user_1", email: "u@example.com" } } }) }),
}))

import { GET } from "./route"

describe("GET /api/community/servers/[id]/channels — human resource", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListEligibleUnreadChannels.mockResolvedValue([])
    mockGetMessagesByIds.mockResolvedValue([])
    mockReadResourceBundle.mockImplementation(async (_db, viewerId: string, input: { channelIds: string[]; messageIds: string[]; serverIds: string[] }) => {
      const visible = await mockListServerChannelsForViewer()
      const projection = await mockListParticipatingForumThreads()
      const candidates = new Map([...visible, ...projection.canonical, ...(projection.retained ? [projection.retained] : [])].map(row => [row.id, row]))
      const channels = input.channelIds.map(id => {
        const row = candidates.get(id)
        if (!row) throw new Error(`Missing explicit channel fixture ${id}`)
        const { activityAt: _activityAt, ...channel } = row
        return CommunityChannelResourceSchema.parse(channel)
      })
      const messages = await mockGetMessagesByIds()
      return fullResourceBundleFixture(viewerId, [serverResourceFixture({ id: "server_1", ownerId: "owner", isOwner: false })], channels, messages)
    })
  })

  it("returns only viewer-visible channel rows after one server membership gate", async () => {
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListServerChannelsForViewer.mockResolvedValue([channelResourceFixture({ id: "channel_1", serverId: "server_1", name: "general" })])
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/channels"),
      { params: { id: "server_1" } } as never,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ channels: [channelResourceFixture({ id: "channel_1", serverId: "server_1", name: "general" })] })
    expect(mockListServerChannelsForViewer).toHaveBeenCalledWith(expect.anything(), "server_1", "user_1")
  })

  it("reuses the scoped participant query for visible text and forum parents", async () => {
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListServerChannelsForViewer.mockResolvedValue([
      channelResourceFixture({ id: "forum_visible", serverId: "server_1", type: "forum" }),
      channelResourceFixture({ id: "text_visible", serverId: "server_1", type: "text" }),
      channelResourceFixture({ id: "child", serverId: "server_1", type: "thread", parentChannelId: "text_visible", parentMessageId: "other-opener" }),
    ])
    const thread = { ...channelResourceFixture({ id: "text_child", serverId: "server_1", type: "thread", parentChannelId: "text_visible", parentMessageId: "opener" }), activityAt: "2026-08-08T11:00:00.000Z" }
    mockListParticipatingForumThreads.mockResolvedValue({ canonical: [thread], retained: null, retainedDisposition: null })
    mockGetMessagesByIds.mockResolvedValue([messageResourceFixture({ id: "opener", channelId: "text_visible", content: "Text opener" })])
    const response = await GET(new NextRequest("http://localhost/api/community/servers/server_1/channels?type=thread&parentType=forum,text&participating=true&activeWithin=72h&limitPerParent=5&include=parentMessage"), { params: { id: "server_1" } } as never)
    expect(response.status).toBe(200)
    expect(mockListParticipatingForumThreads).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ parentChannelIds: ["forum_visible", "text_visible"], userId: "user_1", limitPerParent: 5 }))
    expect(mockReadResourceBundle).toHaveBeenCalledWith(expect.anything(), "user_1", { channelIds: ["forum_visible", "text_visible", "text_child"], messageIds: ["opener"], serverIds: ["server_1"] })
    expect(CommunityForumSidebarEnvelopeSchema.parse(await response.json())).toMatchObject({ channels: [expect.objectContaining({ id: "text_child" })], resources: { messages: [expect.objectContaining({ id: "opener", channelId: "text_visible", content: "Text opener" })] } })
  })

  it("returns recent participating forum threads with opener messages and server-relative expiry", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"))
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListServerChannelsForViewer.mockResolvedValue([
      channelResourceFixture({ id: "forum_visible", serverId: "server_1", name: "Forum", type: "forum" }),
      channelResourceFixture({ id: "text_visible", serverId: "server_1", name: "General", type: "text" }),
    ])
    const thread = { ...channelResourceFixture({ id: "thread_1", serverId: "server_1", type: "thread", parentChannelId: "forum_visible", parentMessageId: "message_1" }),
      id: "thread_1",
      serverId: "server_1",
      parentChannelId: "forum_visible",
      parentMessageId: "message_1",
      type: "thread",
      activityAt: "2026-08-08T11:00:00.000Z",
    }
    mockListParticipatingForumThreads.mockResolvedValue({
      canonical: [thread],
      retained: thread,
      retainedDisposition: "eligible",
    })
    mockGetMessagesByIds.mockResolvedValue([messageResourceFixture({ id: "message_1", channelId: "forum_visible", content: "Current title" })])
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
      expect(CommunityForumSidebarEnvelopeSchema.parse(await response.json())).toEqual({
        schemaVersion: BUSINESS_SCHEMA_VERSION, serverId: "server_1",
        resources: await mockReadResourceBundle.mock.results[0]!.value,
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
        retainedDisposition: "eligible",
        serverNow: "2026-08-08T12:00:00.000Z",
      })
      expect(mockListEligibleUnreadChannels).toHaveBeenCalledWith(expect.anything(), "user_1", ["thread_1"])
      expect(mockReadResourceBundle).toHaveBeenCalledWith(expect.anything(), "user_1", { channelIds: ["forum_visible", "thread_1"], messageIds: ["message_1"], serverIds: ["server_1"] })
      expect((await mockReadResourceBundle.mock.results[0]!.value).messages).toMatchObject([{ id: "message_1", channelId: "forum_visible", content: "Current title" }])
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps canonical order intact and builds retained display order with binary comparison", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"))
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListServerChannelsForViewer.mockResolvedValue([
      channelResourceFixture({ id: "forum_visible", serverId: "server_1", name: "Forum", type: "forum" }),
    ])
    const row = (id: string) => ({
      ...channelResourceFixture({ id, serverId: "server_1", type: "thread", parentChannelId: "forum_visible", parentMessageId: `message_${id}` }),
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
      retainedDisposition: "eligible",
    })
    mockGetMessagesByIds.mockResolvedValue([
      messageResourceFixture({ id: "message_z", channelId: "forum_visible", content: "Z" }),
      messageResourceFixture({ id: "message_a", channelId: "forum_visible", content: "A" }),
      messageResourceFixture({ id: "message_ä", channelId: "forum_visible", content: "Retained" }),
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

  it("serializes an archived-opener retained negative without returning the child", async () => {
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListServerChannelsForViewer.mockResolvedValue([
      channelResourceFixture({ id: "forum_visible", serverId: "server_1", name: "Forum", type: "forum" }),
    ])
    mockListParticipatingForumThreads.mockResolvedValue({
      canonical: [],
      retained: null,
      retainedDisposition: "opener-archived",
    })
    mockGetMessagesByIds.mockResolvedValue([])

    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/channels?type=thread&parentType=forum&participating=true&activeWithin=72h&limitPerParent=5&retainId=thread_archived&include=parentMessage"),
      { params: { id: "server_1" } } as never,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      channels: [],
      canonicalChannels: [],
      retainedChannel: null,
      retainedDisposition: "opener-archived",
      resources: { messages: [] },
    })
    expect(mockReadResourceBundle).toHaveBeenCalledWith(expect.anything(), "user_1", { channelIds: ["forum_visible"], messageIds: [], serverIds: ["server_1"] })
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
