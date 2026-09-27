import { describe, it, expect } from "vitest"
import { patchChannelUnread } from "./server-detail-cache"
import type { ServerDetail } from "./use-servers"

function fixture(): ServerDetail {
  return {
    id: "srv_1",
    name: "Server",
    description: "",
    icon: null,
    ownerId: "u_owner",
    categories: [
      {
        id: "cat_A",
        name: "Category A",
        channels: [
          { id: "ch_a1", name: "general", active: false, unread: false },
          { id: "ch_a2", name: "random", active: false, unread: false },
        ],
      },
      {
        id: "cat_B",
        name: "Category B",
        channels: [
          { id: "ch_b1", name: "b1", active: false, unread: false },
        ],
      },
    ],
  }
}

describe("patchChannelUnread", () => {
  it("flips the target channel's unread flag inside the correct category", () => {
    const cache = fixture()
    const next = patchChannelUnread(cache, "ch_a2", true)
    expect(next?.categories[0].channels.find((c) => c.id === "ch_a2")?.unread).toBe(true)
  })

  it("leaves every other channel/category untouched — same object references for unrelated categories", () => {
    const cache = fixture()
    const next = patchChannelUnread(cache, "ch_a2", true)
    // The sibling channel keeps its exact reference.
    expect(next?.categories[0].channels.find((c) => c.id === "ch_a1")).toBe(cache.categories[0].channels[0])
    // The unrelated category object itself is untouched (same reference).
    expect(next?.categories[1]).toBe(cache.categories[1])
  })

  it("returns the input unchanged when cache is undefined", () => {
    expect(patchChannelUnread(undefined, "ch_a1", true)).toBeUndefined()
  })

  it("returns the input unchanged (same reference) when the channel id doesn't exist anywhere", () => {
    const cache = fixture()
    const next = patchChannelUnread(cache, "ch_missing", true)
    expect(next).toBe(cache)
  })

  it("works identically for unread: true (WS-arrival direction) and unread: false (click direction)", () => {
    const cache = fixture()
    const toTrue = patchChannelUnread(cache, "ch_a1", true)
    expect(toTrue?.categories[0].channels.find((c) => c.id === "ch_a1")?.unread).toBe(true)
    const toFalse = patchChannelUnread(toTrue, "ch_a1", false)
    expect(toFalse?.categories[0].channels.find((c) => c.id === "ch_a1")?.unread).toBe(false)
  })

  // Regression: without the click-time cache patch, a later sibling-channel
  // update would overwrite the optimistic mark-read and make A unread again.
  it("clicking channel A then a WS patch for sibling channel B does not resurrect A's cleared dot", () => {
    let cache: ServerDetail | undefined = fixture()
    // Seed A as unread (as if a message arrived earlier).
    cache = patchChannelUnread(cache, "ch_a1", true)
    // User clicks A — optimistic clear.
    cache = patchChannelUnread(cache, "ch_a1", false)
    // Unrelated WS message arrives for sibling channel B.
    cache = patchChannelUnread(cache, "ch_a2", true)
    expect(cache?.categories[0].channels.find((c) => c.id === "ch_a1")?.unread).toBe(false)
    expect(cache?.categories[0].channels.find((c) => c.id === "ch_a2")?.unread).toBe(true)
  })
})
