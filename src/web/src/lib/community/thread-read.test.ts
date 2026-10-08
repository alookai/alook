import { beforeEach, describe, expect, it, vi } from "vitest"
import { COMMUNITY_CONTRACT_HEADER, CommunityThreadsReadSchema } from "@alook/shared"

const mocks = vi.hoisted(() => ({ attachments: vi.fn(), reactions: vi.fn(), replies: vi.fn() }))
vi.mock("@alook/shared", async (original) => ({ ...await original<typeof import("@alook/shared")>(), queries: {
  communityAttachment: { listByMessageIds: mocks.attachments },
  communityReaction: { listReactionsByMessageIds: mocks.reactions },
  communityMessage: { getMessagesByIdsInChannels: mocks.replies },
} }))
import { writeCommunityThreadsRead } from "./thread-read"

const db = {} as never
const parent = { id: "forum", type: "forum", serverId: "server", name: "Forum", archived: 0, createdAt: "2026-10-07T12:00:00Z" }
const child = { ...parent, id: "thread", type: "thread", parentChannelId: "forum", parentMessageId: "opener", creatorId: "viewer" }
const row = (id: string, channelId: string) => ({ id, channelId, seq: 4, authorId: "viewer", authorName: "Viewer", authorImage: null, authorAvatarVersion: 0,
  content: id, type: "default", mentionType: null, replyToId: null as string | null, embeds: [], createdAt: "2026-10-07T12:00:00Z", clientNonce: "client-nonce" })
type Included = NonNullable<Parameters<typeof writeCommunityThreadsRead>[4]>
const included = (): Included => ({ messages: [row("opener", "forum"), { ...row("reply", "thread"), replyToId: "previous" }], tags: [{ messageId: "opener", tag: "bug" }],
  participants: [{ channelId: "thread", userId: "viewer", userName: "Viewer", userImage: null, userAvatarVersion: 0, participantCount: 8 }] })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.attachments.mockResolvedValue([])
  mocks.reactions.mockResolvedValue([])
  mocks.replies.mockResolvedValue([])
})

describe("complete thread read resource", () => {
  it("writes the scoped message, attachment, reaction, reply and participant identities", async () => {
    mocks.attachments.mockResolvedValue([{ id: "attachment", messageId: "reply", targetId: "thread", filename: "note.txt", r2Key: "owned-key", contentType: "text/plain", size: 42 }])
    mocks.reactions.mockResolvedValue([{ messageId: "reply", emoji: "👍", userId: "viewer" }])
    mocks.replies.mockResolvedValue([{ ...row("previous", "thread"), content: "same-channel reply" }, { ...row("previous", "foreign"), content: "foreign private body" }])
    const response = await writeCommunityThreadsRead(db, "viewer", parent, [child], included(), { hasMore: true, nextCursor: "next" })
    expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe("2")
    const body = CommunityThreadsReadSchema.parse(await response.json())
    expect(body).toMatchObject({ contractVersion: 2, channelId: "forum", channel: { id: "forum" }, threads: [{ id: "thread", parentChannelId: "forum" }],
      included: { tags: [{ messageId: "opener", tag: "bug" }], members: [{ channelId: "thread", userId: "viewer", relation: "notify", isCreator: true }],
        profiles: [{ id: "viewer", name: "Viewer", avatarVersion: 0 }], participantCounts: [{ channelId: "thread", count: 8 }] }, page: { hasMore: true, nextCursor: "next" } })
    expect(body.included.messages.find((message) => message.id === "reply")).toMatchObject({ channelId: "thread", seq: 4, clientNonce: "client-nonce", replyToId: "previous", type: "chat",
      replyTo: { id: "previous", text: "same-channel reply", authorId: "viewer" }, attachments: [{ kind: "file", name: "note.txt", sizeBytes: 42 }], reactions: [{ emoji: "👍", me: true, count: 1, userIds: ["viewer"] }] })
    expect(JSON.stringify(body)).not.toContain("foreign private body")
    expect(mocks.attachments).toHaveBeenCalledWith(db, ["opener", "reply"])
    expect(mocks.reactions).toHaveBeenCalledWith(db, ["opener", "reply"], "viewer")
    expect(mocks.replies).toHaveBeenCalledWith(db, ["previous"], ["forum", "thread"])
  })

  it("marks a foreign-only reply as deleted instead of disclosing its text", async () => {
    mocks.replies.mockResolvedValue([{ ...row("previous", "foreign"), content: "private" }])
    const response = await writeCommunityThreadsRead(db, "viewer", parent, [child], included())
    const body = CommunityThreadsReadSchema.parse(await response.json())
    expect(body.included.messages.find((message) => message.id === "reply")?.replyTo).toEqual({ id: "previous", authorName: "Deleted user", text: "", deleted: true })
  })

  it("does not disclose a reply from a legitimate sibling in the same included query", async () => {
    const sibling = { ...child, id: "sibling", parentMessageId: "sibling-opener" }
    mocks.replies.mockResolvedValue([{ ...row("previous", "sibling"), content: "sibling private reply" }])
    const response = await writeCommunityThreadsRead(db, "viewer", parent, [child, sibling], included())
    const body = CommunityThreadsReadSchema.parse(await response.json())
    expect(body.included.messages.find((message) => message.id === "reply")?.replyTo).toEqual({ id: "previous", authorName: "Deleted user", text: "", deleted: true })
    expect(JSON.stringify(body)).not.toContain("sibling private reply")
    expect(mocks.replies).toHaveBeenCalledWith(db, ["previous"], ["forum", "thread", "sibling"])
  })

  it("writes empty reads with default pagination and no fabricated included resource", async () => {
    const response = await writeCommunityThreadsRead(db, "viewer", parent, [])
    expect(CommunityThreadsReadSchema.parse(await response.json())).toMatchObject({ threads: [], included: { messages: [], tags: [], members: [], profiles: [], participantCounts: [] }, page: { nextCursor: null, hasMore: false } })
    expect(mocks.replies).toHaveBeenCalledWith(db, [], ["forum"])
    expect(mocks.attachments).toHaveBeenCalledWith(db, [])
    expect(mocks.reactions).toHaveBeenCalledWith(db, [], "viewer")
  })

  it("deduplicates profiles while preserving the scoped participant counts", async () => {
    const participant = { channelId: "thread", userId: "viewer", userName: null, userImage: null, userAvatarVersion: 0, participantCount: 2 }
    const otherChild = { ...child, id: "other-thread", creatorId: "other" }
    const participants = [participant, { ...participant, userId: "other" }, { ...participant, channelId: "other-thread", participantCount: 1 }]
    const response = await writeCommunityThreadsRead(db, "viewer", parent, [child, otherChild], { messages: [], tags: [], participants })
    const body = CommunityThreadsReadSchema.parse(await response.json())
    expect(body.included.profiles.map((profile) => profile.id)).toEqual(["viewer", "other"])
    expect(body.included.profiles[0]?.name).toBe("")
    expect(body.included.participantCounts).toEqual([{ channelId: "thread", count: 2 }, { channelId: "other-thread", count: 1 }])
    expect(body.included.members.map((member) => member.isCreator)).toEqual([true, false, false])
  })

  it.each([{ ...child, parentChannelId: "other" }, { ...child, serverId: "other" }])("rejects an unrelated child before any included query", async (invalidChild) => {
    await expect(writeCommunityThreadsRead(db, "viewer", parent, [invalidChild], included())).rejects.toThrow("Thread resource scope mismatch")
    expect(mocks.attachments).not.toHaveBeenCalled()
    expect(mocks.replies).not.toHaveBeenCalled()
  })

  it("rejects an unrelated included message before querying its private attachments", async () => {
    await expect(writeCommunityThreadsRead(db, "viewer", parent, [child], { ...included(), messages: [row("foreign", "other")] })).rejects.toThrow("Included message scope mismatch")
    expect(mocks.attachments).not.toHaveBeenCalled()
    expect(mocks.replies).not.toHaveBeenCalled()
  })
})
