import { describe, expect, it } from "vitest"
import { CommunityDmsReadSchema, parseCommunityDmsRead } from "../src/community-dms"
import { CommunityChannelResourceSchema, CommunityResourceProfileSchema } from "../src/community-resources"
import { communityResourceChannelFixture } from "./community-ws-events.fixtures"

const item = (id = "dm", peerId = "peer") => ({
  id, userId: peerId, preview: "", activityAt: "2026-10-28T00:00:00Z", unread: false,
  channel: { ...communityResourceChannelFixture, id, type: "dm", serverId: null, parentChannelId: null, parentMessageId: null, categoryId: null, name: null },
  profile: { id: peerId, name: "Peer", discriminator: "0001", avatar: null, avatarVersion: 0 },
  memberships: ["viewer", peerId].map(userId => ({ channelId: id, userId, relation: "access", source: "added", isCreator: false, role: null, memberId: null })),
})

describe("named complete current DM read", () => {
  it("uses the unique complete resource schemas and keeps the DTO independent from UI identity", () => {
    const shape = CommunityDmsReadSchema.shape.conversations.element.shape
    expect(shape.channel).toBe(CommunityChannelResourceSchema)
    expect(shape.profile).toBe(CommunityResourceProfileSchema)
    const value = { conversations: [item()] }
    expect(parseCommunityDmsRead(value, "viewer")).toEqual(value)
    expect(Object.keys(value.conversations[0]!)).not.toContain("name")
    expect(parseCommunityDmsRead({ conversations: [] }, "viewer")).toEqual({ conversations: [] })
  })
  it.each(["name", "discriminator", "avatar", "avatarVersion"])("refuses the second %s identity source", key => {
    expect(() => parseCommunityDmsRead({ conversations: [{ ...item(), [key]: "duplicate" }] }, "viewer")).toThrow()
  })
  it.each(["avatar", "avatarVersion", "name", "discriminator"])("refuses a missing full profile %s", key => {
    const value = item()
    delete (value.profile as Record<string, unknown>)[key]
    expect(() => parseCommunityDmsRead({ conversations: [value] }, "viewer")).toThrow()
  })
  it.each(["peer", "channel", "member-channel", "member-relation", "viewer", "self-peer", "foreign-parent", "foreign-category", "foreign-opener"])("rejects mismatched %s closure", kind => {
    const value = item()
    if (kind === "peer") value.profile.id = "other"
    if (kind === "channel") value.channel.id = "other"
    if (kind === "member-channel") value.memberships[1]!.channelId = "other"
    if (kind === "member-relation") value.memberships[1]!.relation = "notify"
    if (kind === "viewer") value.memberships[0]!.userId = "other-viewer"
    if (kind === "foreign-parent") Object.assign(value.channel, { parentChannelId: "foreign" })
    if (kind === "foreign-category") Object.assign(value.channel, { categoryId: "foreign" })
    if (kind === "foreign-opener") Object.assign(value.channel, { parentMessageId: "foreign" })
    if (kind === "self-peer") value.userId = value.profile.id = "viewer"
    expect(() => parseCommunityDmsRead({ conversations: [value] }, "viewer")).toThrow()
  })
  it("rejects duplicate DM identities and inconsistent unread metadata", () => {
    expect(() => parseCommunityDmsRead({ conversations: [item(), item()] }, "viewer")).toThrow()
    expect(() => parseCommunityDmsRead({ conversations: [{ ...item(), unread: true }] }, "viewer")).toThrow()
    expect(() => parseCommunityDmsRead({ conversations: [{ ...item(), lastUnreadSeq: 1 }] }, "viewer")).toThrow()
    expect(parseCommunityDmsRead({ conversations: [{ ...item(), unread: true, lastUnreadSeq: 1 }] }, "viewer").conversations[0]!.lastUnreadSeq).toBe(1)
  })
})
