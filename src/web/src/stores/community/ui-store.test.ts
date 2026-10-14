import { describe, expect, it } from "vitest"
import { createCommunityStore } from "./ui-store"

describe("pending reply identity", () => {
  it("preserves author identity through navigation and does not discard an identity update", () => {
    const store = createCommunityStore()
    const target = { id: "message", authorName: "Author", text: "@Author#1234 body" }
    store.actions.setPendingReply({ channelId: "destination", target })
    const withIdentity = { channelId: "destination", target: { ...target, authorId: "author" } }
    store.actions.setPendingReply(withIdentity)
    expect(store.get().pendingReply).toBe(withIdentity)
    const before = store.get()
    store.actions.setPendingReply({ ...withIdentity, target: { ...withIdentity.target } })
    expect(store.get()).toBe(before)
    store.actions.setPendingReply(null)
    expect(store.get().pendingReply).toBeNull()
  })
})
