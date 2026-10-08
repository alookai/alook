import { describe, expect, it } from "vitest"
import type { CommunityReactionAdd, CommunityReactionRemove } from "@alook/shared"
import { applyMessageReaction, type Msg } from "@/lib/community/models/message"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { ingestMessages, projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { findCachedMessage } from "../use-message"
import { removeThreadFromCache, type PageCache } from "./cache"

function pageCache(...pages: Msg[][]): PageCache {
  return { pages: pages.map((messages) => ({ messages: messages.map(({ id, seq }) => ({ id, seq })), hasMore: false })), pageParams: pages.map(() => null) }
}
const add: CommunityReactionAdd = { type: "community:reaction.add", channelId: "ch_1", messageId: "m_1", userId: "u_me", emoji: "👍" }
const remove: CommunityReactionRemove = { ...add, type: "community:reaction.remove" }

describe("community WS canonical publication and ID windows", () => {
  it("preserves undefined windows and missing canonical entities", async () => {
    const { client, registry } = await createCommunityQueryOwner("u_me")
    ingestMessages(registry, "ch_1", [{ id: "m_1", content: "one" }])
    const row = registry.collections.messages.get("m_1"), cache = pageCache([{ id: "m_1" }])
    projectCommunityWsEventToDb(client, { type: "community:message.edited", channelId: "ch_1", messageId: "missing", content: "New" })
    expect(registry.collections.messages.get("m_1")).toBe(row)
    expect(registry.collections.messages.has("missing")).toBe(false)
    expect(removeThreadFromCache(undefined, "missing", "missing")).toBeUndefined()
    expect(removeThreadFromCache(cache, "missing", "missing")).toBe(cache)
  })
  it("patches canonical approval and content while preserving non-target rows", async () => {
    const { client, registry } = await createCommunityQueryOwner("u_me")
    ingestMessages(registry, "ch_1", [{ id: "m_1", content: "one" }, { id: "m_2", content: "two" }])
    const other = registry.collections.messages.get("m_2")
    const profile = { id: "u_1", name: "User", discriminator: "0001", image: null }
    const approval = { friendshipId: "friendship_1", status: "approved" as const, waitingOn: null, otherProfile: profile, botProfile: { ...profile, id: "bot_1" } }
    projectCommunityWsEventToDb(client, { type: "community:message.updated", channelId: "ch_1", messageId: "m_1", approval })
    projectCommunityWsEventToDb(client, { type: "community:message.edited", channelId: "ch_1", messageId: "m_1", content: "edited" })
    expect(registry.collections.messages.get("m_1")).toMatchObject({ content: "edited", approval })
    expect(registry.collections.messages.get("m_2")).toBe(other)
  })
  it("evicts the proved opener ID across pages without changing sibling windows or page parameters", () => {
    const cache = pageCache([{ id: "opener", seq: 1 }, { id: "sibling", seq: 2 }], [{ id: "opener", seq: 1 }])
    const result = removeThreadFromCache(cache, "thread", "opener")!
    expect(result.pages[0].messages).toEqual([{ id: "sibling", seq: 2 }])
    expect(result.pages[1].messages).toEqual([])
    expect(result.pages[0].messages[0]).toBe(cache.pages[0].messages[1])
    expect(result.pageParams).toBe(cache.pageParams)
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
    ingestMessages(registry, "ch_1", [{ id: "m_1", reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["u_me"] }] }])
    projectCommunityWsEventToDb(client, remove)
    expect(registry.collections.messages.get("m_1")?.reactions).toEqual([])
    projectCommunityWsEventToDb(client, add)
    projectCommunityWsEventToDb(client, add)
    expect(registry.collections.messages.get("m_1")?.reactions).toEqual([{ emoji: "👍", count: 1, me: true, userIds: ["u_me"] }])
  })
  it("reads the same canonical entity for every ID window and returns undefined for misses", async () => {
    const { client, registry } = await createCommunityQueryOwner("u_me")
    ingestMessages(registry, "ch_1", [{ id: "m_1" }, { id: "m_2", content: "target", authorId: "author", createdAt: "2026-08-15T00:00:02.000Z" }])
    expect(findCachedMessage(client, "m_2")).toMatchObject({ id: "m_2", content: "target" })
    expect(findCachedMessage(client, "missing")).toBeUndefined()
  })
})
