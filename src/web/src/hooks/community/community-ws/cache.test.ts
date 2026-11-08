import { messageProfilesFixture } from "@/test/community-resource-fixtures"
import { messageResourceFixture } from "@/test/community-resource-fixtures"
import { describe, expect, it } from "vitest"
import type { CommunityReactionAdd, CommunityReactionRemove } from "@alook/shared"
import { applyMessageReaction, type Msg } from "@/lib/community/models/message"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { captureCommunityLiveSnapshotToken, publishCommunityMessages, ingestMessages, projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { findCachedMessage } from "../use-message"


const add: CommunityReactionAdd = { type: "community:reaction.add", channelId: "ch_1", messageId: "m_1", userId: "u_me", emoji: "👍" }
const remove: CommunityReactionRemove = { ...add, type: "community:reaction.remove" }

describe("community WS canonical publication and ID windows", () => {
  it("preserves undefined windows and missing canonical entities", async () => {
    const { client, registry } = await createCommunityQueryOwner("u_me")
    ingestMessages(registry, "ch_1", [messageResourceFixture({ id: "m_1", channelId: "ch_1", content: "one" })])
    const row = registry.collections.messages.get("m_1")
    projectCommunityWsEventToDb(client, { type: "community:reaction.add", channelId: "ch_1", messageId: "missing", emoji: "👍", userId: "peer" })
    expect(registry.collections.messages.get("m_1")).toBe(row)
    expect(registry.collections.messages.has("missing")).toBe(false)
  })
  it("patches canonical approval while preserving non-target rows", async () => {
    const { client, registry } = await createCommunityQueryOwner("u_me")
    ingestMessages(registry, "ch_1", [messageResourceFixture({ id: "m_1", channelId: "ch_1", content: "one" }), messageResourceFixture({ id: "m_2", channelId: "ch_1", content: "two", seq: 2 })])
    const other = registry.collections.messages.get("m_2")
    const profile = { id: "u_1", name: "User", discriminator: "0001", image: null, avatarVersion: 0 }
    const approval = { friendshipId: "friendship_1", status: "approved" as const, waitingOn: null, otherProfile: profile, botProfile: { ...profile, id: "bot_1" } }
    projectCommunityWsEventToDb(client, { type: "community:message.updated", channelId: "ch_1", messageId: "m_1", approval })
    expect(registry.collections.messages.get("m_1")).toMatchObject({ content: "one", approval })
    expect(registry.collections.messages.get("m_2")).toBe(other)
  })
  it("adds, deduplicates and removes reactions without mutating the source", () => {
    const message: Msg = { id: "m_1", reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u_1"] }] }
    const added = applyMessageReaction(message.reactions, add.emoji, add.userId, true, "u_me")
    const duplicate = applyMessageReaction(added, add.emoji, add.userId, true, "u_me")
    const removed = applyMessageReaction(duplicate, remove.emoji, remove.userId, false, "u_me")
    expect(message.reactions).toEqual([{ emoji: "👍", count: 1, me: false, userIds: ["u_1"] }])
    expect(added).toEqual([{ emoji: "👍", count: 2, me: true, userIds: ["u_1", "u_me"] }])
    expect(duplicate).toEqual(added)
    expect(removed).toEqual(message.reactions)
  })
  it("patches canonical reactions and removes the last membership", async () => {
    const { client, registry } = await createCommunityQueryOwner("u_me")
    ingestMessages(registry, "ch_1", [messageResourceFixture({ id: "m_1", channelId: "ch_1", reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["u_me"] }] })])
    projectCommunityWsEventToDb(client, remove)
    expect(registry.collections.messages.get("m_1")?.reactions).toEqual([])
    projectCommunityWsEventToDb(client, add)
    projectCommunityWsEventToDb(client, add)
    expect(registry.collections.messages.get("m_1")?.reactions).toEqual([{ emoji: "👍", count: 1, me: true, userIds: ["u_me"] }])
  })
  it("reads the same canonical entity for every ID window and returns undefined for misses", async () => {
    const { client, registry } = await createCommunityQueryOwner("u_me")
    ingestMessages(registry, "ch_1", [messageResourceFixture({ id: "m_1", channelId: "ch_1" }), messageResourceFixture({ id: "m_2", channelId: "ch_1", seq: 2, content: "target", authorId: "author", createdAt: "2026-08-15T00:00:02.000Z" })])
    const messages = [...registry.collections.messages.values()].map(row => messageResourceFixture(Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("$")))))
    await publishCommunityMessages(client, { channelId: "ch_1", messages, profiles: messageProfilesFixture(messages), proof: { token: captureCommunityLiveSnapshotToken(client) } })
    expect(findCachedMessage(client, "m_2")).toMatchObject({ id: "m_2", content: "target" })
    expect(findCachedMessage(client, "missing")).toBeUndefined()
  })
})
