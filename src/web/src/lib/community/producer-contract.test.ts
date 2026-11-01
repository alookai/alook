import { describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, serializeMessageDeliveryBatch, type CommunityChannelMembershipChange, type MessageDeliveryBatch } from "@alook/shared"
import { messageResourceFixture } from "@/test/community-resource-fixtures"
import { communityProducerContract, projectCommunityProducerDelivery, projectCommunityProducerEvent } from "./producer-contract"

const event: CommunityChannelMembershipChange = { type: "community:channel.membership.change", channelId: "thread", serverId: "server", userId: "peer", relation: "notify", present: true }
const batch: MessageDeliveryBatch = { communityContract: BUSINESS_SCHEMA_VERSION, messageId: "message", messageEvent: { type: "community:message.create", profiles: [{ id: "author", name: "Author", discriminator: "0042", avatar: null, avatarVersion: 0 }], channelId: "thread", serverId: "server", message: messageResourceFixture({ id: "message", channelId: "thread", seq: 1, authorId: "author", authorName: "Author", authorAvatarVersion: 0, content: "hello", createdAt: "2026-10-07T12:00:00Z" }) }, contentUserIds: ["author", "peer"], unreadPlainUserIds: [], unreadMentionUserIds: [], mentionUserIds: [], joinedParticipantUserIds: ["peer"], rosterRefreshUserId: "peer" }

describe("current community event production", () => {
  it("produces the sole current membership event including nullable DM server scope", () => {
    expect(communityProducerContract()).toBe(BUSINESS_SCHEMA_VERSION)
    expect(projectCommunityProducerEvent(event, {})).toEqual(event)
    expect(projectCommunityProducerEvent({ ...event, serverId: null }, {})).toEqual({ ...event, serverId: null })
  })
  it("preserves the full current committed delivery and structural participants without mutation", () => {
    const before = structuredClone(batch)
    expect(projectCommunityProducerDelivery(batch, {})).toBe(batch)
    expect(() => serializeMessageDeliveryBatch(batch)).not.toThrow()
    expect(batch).toEqual(before)
  })
  it.each([1, 2, 3])("refuses old source contract %s rather than projecting it", version => {
    expect(() => projectCommunityProducerEvent(event, {}, version)).toThrow("protocol mismatch")
    expect(() => projectCommunityProducerDelivery({ ...batch, communityContract: version } as unknown as MessageDeliveryBatch, {})).toThrow("protocol mismatch")
  })
})
