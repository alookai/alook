import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { COMMUNITY_CONTRACT_HEADER } from "@alook/shared"

const mocks = vi.hoisted(() => ({ db: {}, access: vi.fn(), channel: vi.fn(), friends: vi.fn(), resolve: vi.fn(), participants: vi.fn(), users: vi.fn(), members: vi.fn(),
  children: vi.fn(), threads: vi.fn(), openers: vi.fn(), first: vi.fn(), tags: vi.fn(), threadParticipants: vi.fn(), attachments: vi.fn(), reactions: vi.fn(), replies: vi.fn() }))
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db, getPrimaryDb: () => mocks.db }))
vi.mock("@/lib/community/permissions", () => ({ requireMessageSurfaceAccess: mocks.access, requireChannelAccess: mocks.access }))
vi.mock("@/lib/community/message-door", () => ({ resolveMessageTarget: mocks.resolve }))
vi.mock("@/lib/middleware/auth", () => ({ withAuth: (handler: (request: NextRequest, context: unknown) => Promise<Response>) =>
  async (request: NextRequest, context: { params?: Promise<Record<string, string>> }) => handler(request, { params: await context.params, env: { DB: mocks.db }, userId: "viewer" }) }))
vi.mock("@/lib/middleware/community-actor", () => ({ withCommunityActor: (handler: (request: NextRequest, context: unknown) => Promise<Response>) =>
  async (request: NextRequest, context: { params?: Promise<Record<string, string>> }) => handler(request, { params: await context.params, env: { DB: mocks.db },
    actor: request.headers.has("Authorization") ? { kind: "bot", userId: "bot" } : { kind: "human", userId: "viewer" } }) }))
vi.mock("@alook/shared", async (original) => ({ ...await original<typeof import("@alook/shared")>(), queries: {
  communityChannel: { getChannelForMember: mocks.channel, listChildChannels: mocks.children }, communityFriendship: { areFriends: mocks.friends },
  communityThread: { listThreadParticipants: mocks.participants, listForumThreadsByCreatedAt: mocks.threads, listParticipantsForChannels: mocks.threadParticipants },
  communityMessage: { getMessagesByIdsInScope: mocks.openers, getFirstMessageResourcesByChannelIds: mocks.first, getMessagesByIdsInChannels: mocks.replies },
  communityMessageTag: { listTagsForMessages: mocks.tags }, communityAttachment: { listByMessageIds: mocks.attachments }, communityReaction: { listReactionsByMessageIds: mocks.reactions },
  user: { getUsersByIds: mocks.users }, communityMember: { getMembersByUserIds: mocks.members },
} }))
import { GET as metadata } from "@/app/api/community/channels/[id]/route"
import { GET as roster } from "@/app/api/community/channels/[id]/members/route"
import { GET as threadList } from "@/app/api/community/channels/[id]/threads/route"

const parent = { id: "forum", type: "forum", serverId: "server", name: "Forum", archived: 0, createdAt: "2026-10-07T12:00:00Z" }
const child = { ...parent, id: "thread", type: "thread", parentChannelId: "forum", parentMessageId: "opener", creatorId: "viewer" }
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const req = (path: string, bot = false) => new NextRequest(`https://alook.test/api/community/channels/${path}`, { headers: { [COMMUNITY_CONTRACT_HEADER]: "2", ...(bot ? { Authorization: "Bearer crk_unit_fixture" } : {}) } })
const row = (id: string, channelId: string) => ({ id, channelId, seq: 1, authorId: "viewer", authorName: "Viewer", authorImage: null, authorAvatarVersion: 0, content: id,
  type: "default", mentionType: null, replyToId: null, embeds: [], clientNonce: null, createdAt: "2026-10-07T12:00:00Z" })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.access.mockResolvedValue({ ok: true, value: { surface: "channel", channel: parent } })
  mocks.resolve.mockResolvedValue({ ok: true, value: { target: { channelId: "thread" } } })
  mocks.channel.mockResolvedValue(parent)
  for (const query of [mocks.participants, mocks.users, mocks.members, mocks.children, mocks.threads, mocks.openers, mocks.first, mocks.tags, mocks.threadParticipants, mocks.attachments, mocks.reactions, mocks.replies]) query.mockResolvedValue([])
})

describe("negotiated complete read route boundaries", () => {
  it.each([false, true])("keeps DM reading separate from friendship-dependent sending: friends=%s", async (friends) => {
    mocks.access.mockResolvedValue({ ok: true, value: { surface: "dm", dm: { otherUserId: "peer" } } })
    mocks.channel.mockResolvedValue({ ...parent, id: "dm", type: "dm", serverId: null, name: null })
    mocks.friends.mockResolvedValue(friends)
    const response = await metadata(req("dm"), ctx("dm"))
    expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe("2")
    expect(await response.json()).toMatchObject({ channelId: "dm", channel: { id: "dm", type: "dm" }, access: { channelId: "dm", canRead: true, canSend: friends, canCreateDiscussion: false } })
    expect(mocks.channel).toHaveBeenCalledWith(mocks.db, "dm", "viewer")
    expect(mocks.friends).toHaveBeenCalledWith(mocks.db, "viewer", "peer")
  })

  it("returns not-found for a vanished DM without checking friendship", async () => {
    mocks.access.mockResolvedValue({ ok: true, value: { surface: "dm", dm: { otherUserId: "peer" } } })
    mocks.channel.mockResolvedValue(null)
    expect((await metadata(req("dm"), ctx("dm"))).status).toBe(404)
    expect(mocks.friends).not.toHaveBeenCalled()
  })

  it.each([false, true])("resolves a current human/bot roster through the complete reader: bot=%s", async (bot) => {
    mocks.access.mockResolvedValue({ ok: true, value: { surface: "channel", channel: child } })
    mocks.participants.mockResolvedValue([{ userId: "viewer", source: "spoke" }])
    mocks.users.mockResolvedValue([{ id: "viewer", name: "Viewer", image: null, avatarVersion: 0 }])
    const response = await roster(req(`thread/members?relation=notify${bot ? "&ref=%2Fserver%2Fthread" : ""}`, bot), ctx("thread"))
    expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe("2")
    expect(await response.json()).toMatchObject({ channelId: "thread", relation: "notify", members: [{ userId: "viewer", source: "spoke" }] })
    expect(mocks.resolve).toHaveBeenCalledWith(mocks.db, bot ? "bot" : "viewer", bot ? { ref: "/server/thread" } : { id: "thread" }, bot ? "bot" : "human")
  })

  it("returns the scoped target rejection before reading any roster", async () => {
    mocks.resolve.mockResolvedValue({ ok: false, status: 404, error: "not found" })
    expect((await roster(req("thread/members?relation=notify"), ctx("thread"))).status).toBe(404)
    expect(mocks.access).not.toHaveBeenCalled()
    expect(mocks.participants).not.toHaveBeenCalled()
  })

  it("returns a complete empty DM child collection", async () => {
    mocks.access.mockResolvedValue({ ok: true, value: { surface: "dm", dm: { otherUserId: "peer" } } })
    mocks.channel.mockResolvedValue({ ...parent, id: "dm", type: "dm", serverId: null, name: null })
    const response = await threadList(req("dm/threads"), ctx("dm"))
    expect(await response.json()).toMatchObject({ contractVersion: 2, channelId: "dm", threads: [], included: { messages: [] } })
    expect(mocks.children).not.toHaveBeenCalled()
  })

  it("rejects child enumeration at the full reading gate", async () => {
    mocks.access.mockResolvedValue({ ok: false, status: 403, error: "forbidden" })
    expect((await threadList(req("forum/threads"), ctx("forum"))).status).toBe(403)
    expect(mocks.children).not.toHaveBeenCalled()
    expect(mocks.threads).not.toHaveBeenCalled()
    expect(mocks.openers).not.toHaveBeenCalled()
  })

  it("assembles only the selected page's parent and first committed messages", async () => {
    mocks.threads.mockResolvedValue([child, { ...child, id: "next-thread" }])
    mocks.openers.mockResolvedValue([row("opener", "forum")])
    mocks.first.mockResolvedValue([row("first", "thread")])
    mocks.tags.mockResolvedValue([{ messageId: "opener", tag: "bug" }])
    mocks.threadParticipants.mockResolvedValue([{ channelId: "thread", userId: "viewer", userName: "Viewer", userImage: null, userAvatarVersion: 0, participantCount: 1 }])
    const response = await threadList(req("forum/threads?order=createdAt&include=parentMessage,firstMessage,tags,participants&limit=1"), ctx("forum"))
    expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe("2")
    const body = await response.json()
    expect(body).toMatchObject({ channelId: "forum", threads: [{ id: "thread" }], included: { messages: [{ id: "opener", channelId: "forum", seq: 1 }, { id: "first", channelId: "thread", seq: 1 }],
      members: [{ userId: "viewer", relation: "notify" }], tags: [{ messageId: "opener", tag: "bug" }] }, page: { hasMore: true, nextCursor: expect.any(String) } })
    expect(body.threads).toHaveLength(1)
    expect(mocks.first).toHaveBeenCalledWith(mocks.db, ["thread"])
    expect(mocks.openers).toHaveBeenCalledWith(mocks.db, ["opener"], { channelId: "forum" })
    expect(mocks.threadParticipants).toHaveBeenCalledWith(mocks.db, ["thread"], 5)
  })
})
