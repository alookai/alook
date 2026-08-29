import { describe, expect, it } from "vitest"
import type {
  CommunityReactionAdd,
  CommunityReactionRemove,
} from "@alook/shared"
import type { Msg } from "@/lib/community/models/message"
import {
  applyReactionToCache,
  applyReactionToMessage,
  findCachedMessage,
  patchApprovalInCache,
  patchMessageContentInCache,
  removeThreadFromCache,
  type PageCache,
} from "./cache"

function pageCache(...pages: Msg[][]): PageCache {
  return {
    pages: pages.map((messages) => ({ messages, hasMore: false })),
    pageParams: pages.map(() => null),
  }
}

describe("community WS cache helpers", () => {
  it("preserves identity for undefined caches and misses", () => {
    const cache = pageCache([{ id: "m_1", content: "one" }])
    expect(patchMessageContentInCache(cache, "m_missing", "New")).toBe(cache)
    expect(removeThreadFromCache(cache, "thread_missing")).toBe(cache)
  })

  it("patches approval and content while preserving non-target rows", () => {
    const other = { id: "m_2", content: "two" }
    const cache = pageCache([{ id: "m_1", content: "one" }, other])
    const profile = { id: "u_1", name: "User", discriminator: "0001", image: null }
    const approval = {
      friendshipId: "friendship_1",
      status: "approved" as const,
      waitingOn: null,
      otherProfile: profile,
      botProfile: { ...profile, id: "bot_1" },
    }

    const approved = patchApprovalInCache(cache, "m_1", approval)!
    const edited = patchMessageContentInCache(approved, "m_1", "edited")!

    expect(edited.pages[0].messages[0]).toMatchObject({ content: "edited", approval })
    expect(edited.pages[0].messages[1]).toBe(other)
  })

  it("removes only rows whose thread id matches", () => {
    const kept = { id: "m_2", thread: { id: "thread_2" } }
    const cache = pageCache(
      [{ id: "m_1", thread: { id: "thread_1" } }, kept],
      [{ id: "m_3", thread: { id: "thread_1" } }],
    )

    const result = removeThreadFromCache(cache, "thread_1")!

    expect(result.pages[0].messages).toEqual([kept])
    expect(result.pages[1].messages).toEqual([])
  })

  it("adds, deduplicates, and removes reactions without mutating the source", () => {
    const message: Msg = {
      id: "m_1",
      reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u_1"] }],
    }
    const add: CommunityReactionAdd = {
      type: "community:reaction.add",
      channelId: "ch_1",
      messageId: "m_1",
      userId: "u_me",
      emoji: "👍",
    }
    const remove: CommunityReactionRemove = {
      type: "community:reaction.remove",
      channelId: "ch_1",
      messageId: "m_1",
      userId: "u_me",
      emoji: "👍",
    }

    const added = applyReactionToMessage(message, add, "u_me")
    const duplicate = applyReactionToMessage(added, add, "u_me")
    const removed = applyReactionToMessage(duplicate, remove, "u_me")

    expect(message.reactions).toEqual([{ emoji: "👍", count: 1, me: false, userIds: ["u_1"] }])
    expect(added.reactions).toEqual([{ emoji: "👍", count: 2, me: true, userIds: ["u_1", "u_me"] }])
    expect(duplicate.reactions).toEqual(added.reactions)
    expect(removed.reactions).toEqual([{ emoji: "👍", count: 1, me: false, userIds: ["u_1"] }])
  })

  it("patches a matching cached reaction and removes the last reaction", () => {
    const cache = pageCache([{
      id: "m_1",
      reactions: [{ emoji: "🔥", count: 1, me: true, userIds: ["u_me"] }],
    }])
    const remove: CommunityReactionRemove = {
      type: "community:reaction.remove",
      channelId: "ch_1",
      messageId: "m_1",
      userId: "u_me",
      emoji: "🔥",
    }

    const result = applyReactionToCache(cache, remove, "u_me")!

    expect(result).not.toBe(cache)
    expect(result.pages[0].messages[0].reactions).toEqual([])
  })

  it("finds messages across pages and returns undefined for misses", () => {
    const target = { id: "m_2", content: "target" }
    const cache = pageCache([{ id: "m_1" }], [target])
    expect(findCachedMessage(cache, "m_2")).toBe(target)
    expect(findCachedMessage(cache, "m_missing")).toBeUndefined()
    expect(findCachedMessage(undefined, "m_1")).toBeUndefined()
  })
})
