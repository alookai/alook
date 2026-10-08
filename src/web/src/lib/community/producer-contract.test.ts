import { describe, expect, it } from "vitest"
import { serializeMessageDeliveryBatch, type CommunityChannelMembershipChange, type MessageDeliveryBatch } from "@alook/shared"
import { projectCommunityProducerDelivery, projectCommunityProducerEvent } from "./producer-contract"

const event: CommunityChannelMembershipChange = { type: "community:channel.membership.change", channelId: "thread", serverId: "server", userId: "peer", relation: "notify", present: true }
const batch: MessageDeliveryBatch = { messageId: "message", messageEvent: { type: "community:message.create", channelId: "thread", serverId: "server", message: { id: "message", seq: 1, authorId: "author", authorName: "Author", authorAvatarVersion: 0, type: "chat", content: "hello", createdAt: "2026-10-07T12:00:00Z" } }, contentUserIds: ["author", "peer"], unreadPlainUserIds: [], unreadMentionUserIds: [], mentionUserIds: [], joinedParticipantUserIds: ["peer"], rosterRefreshUserId: "peer" }

describe("staged community event production", () => {
  it("defaults to the exact old control shape until v2 production is enabled", () => {
    expect(projectCommunityProducerEvent(event, {})).toEqual({ type: "community:channel.member_add", channelId: "thread", serverId: "server", userId: "peer" })
    expect(projectCommunityProducerEvent(event, { COMMUNITY_EVENT_CONTRACT: "2" })).toBe(event)
    expect(() => projectCommunityProducerEvent({ ...event, serverId: null }, {})).toThrow("requires producer contract v2")
  })
  it("selects the old committed-delivery shape without mutating its source", () => {
    const legacy = projectCommunityProducerDelivery(batch, {})
    expect(legacy).not.toHaveProperty("joinedParticipantUserIds")
    expect(legacy).not.toHaveProperty("rosterRefreshUserId")
    expect(legacy.memberAdded).toEqual({ channelId: "thread", serverId: "server", userId: "peer" })
    expect(() => serializeMessageDeliveryBatch(legacy)).not.toThrow()
    expect(projectCommunityProducerDelivery(batch, { COMMUNITY_EVENT_CONTRACT: "2" })).toBe(batch)
    expect(batch.joinedParticipantUserIds).toEqual(["peer"])
  })
})
