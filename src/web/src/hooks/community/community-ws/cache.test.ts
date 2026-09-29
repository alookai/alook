import { describe, expect, it } from "vitest"
import type {
  CommunityReactionAdd,
  CommunityReactionRemove,
} from "@alook/shared"
import type { Msg } from "@/lib/community/models/message"
import { applyReactionToMessage } from "./cache"

describe("community WS cache helpers", () => {
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

  it("removes the final reaction from one canonical message", () => {
    const message: Msg = {
      id: "m_1",
      reactions: [{ emoji: "🔥", count: 1, me: true, userIds: ["u_me"] }],
    }
    const remove: CommunityReactionRemove = {
      type: "community:reaction.remove",
      channelId: "ch_1",
      messageId: "m_1",
      userId: "u_me",
      emoji: "🔥",
    }

    const result = applyReactionToMessage(message, remove, "u_me")

    expect(result).not.toBe(message)
    expect(result.reactions).toEqual([])
  })
})
