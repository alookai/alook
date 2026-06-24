import { describe, it, expect } from "vitest"
import {
  isCat,
  catId,
  catOf,
  moveChannelAcrossCategories,
  reorderChannelsWithin,
  reorderCategories,
  type ChannelOrder,
} from "./use-channel-tree"
import type { Channel } from "./_types"

const ch = (id: string): Channel => ({ id, name: id, active: false, unread: false })

const order: ChannelOrder = {
  cat_A: [ch("a1"), ch("a2")],
  cat_B: [ch("b1"), ch("b2"), ch("b3")],
}

describe("id helpers", () => {
  it("isCat / catId", () => {
    expect(catId("cat_A")).toBe("cat_A")
    expect(isCat("cat_A")).toBe(true)
    expect(isCat("a1")).toBe(false)
  })
})

describe("catOf", () => {
  it("resolves the category holding a channel", () => {
    expect(catOf("a2", order)).toBe("cat_A")
    expect(catOf("b3", order)).toBe("cat_B")
  })
  it("resolves a category id to itself", () => {
    expect(catOf("cat_B", order)).toBe("cat_B")
  })
  it("returns undefined for an unknown channel", () => {
    expect(catOf("zzz", order)).toBeUndefined()
  })
})

describe("moveChannelAcrossCategories", () => {
  it("relocates a channel into another category at the over index", () => {
    const next = moveChannelAcrossCategories(order, "a1", "b2")
    expect(next.cat_A.map((c) => c.id)).toEqual(["a2"])
    expect(next.cat_B.map((c) => c.id)).toEqual(["b1", "a1", "b2", "b3"])
  })
  it("is a no-op within the same category", () => {
    expect(moveChannelAcrossCategories(order, "a1", "a2")).toBe(order)
  })
  it("is a no-op for a missing channel", () => {
    expect(moveChannelAcrossCategories(order, "zzz", "b1")).toBe(order)
  })
})

describe("reorderChannelsWithin", () => {
  it("reorders channels inside one category", () => {
    const next = reorderChannelsWithin(order, "b1", "b3")
    expect(next.cat_B.map((c) => c.id)).toEqual(["b2", "b3", "b1"])
  })
  it("is a no-op when over is in a different category", () => {
    expect(reorderChannelsWithin(order, "a1", "b1")).toBe(order)
  })
})

describe("reorderCategories", () => {
  it("reorders the category id list", () => {
    expect(reorderCategories(["cat_A", "cat_B", "cat_C"], "cat_A", "cat_C")).toEqual(["cat_B", "cat_C", "cat_A"])
  })
  it("returns the input when a category is missing", () => {
    const cats = ["cat_A", "cat_B"]
    expect(reorderCategories(cats, "cat_Z", "cat_A")).toBe(cats)
  })
})
