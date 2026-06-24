import { describe, it, expect } from "vitest"
import { reorderRail, FOLDER_ID } from "./use-rail-order"

describe("reorderRail", () => {
  const base = ["sv_a", "sv_b", "sv_c", FOLDER_ID]

  it("moves an id to a later position", () => {
    expect(reorderRail(base, "sv_a", "sv_c")).toEqual(["sv_b", "sv_c", "sv_a", FOLDER_ID])
  })

  it("moves an id to an earlier position", () => {
    expect(reorderRail(base, "sv_c", "sv_a")).toEqual(["sv_c", "sv_a", "sv_b", FOLDER_ID])
  })

  it("treats the folder placeholder as a sortable item", () => {
    expect(reorderRail(base, FOLDER_ID, "sv_a")).toEqual([FOLDER_ID, "sv_a", "sv_b", "sv_c"])
  })

  it("returns the same order for a no-op (active === over)", () => {
    expect(reorderRail(base, "sv_b", "sv_b")).toBe(base)
  })

  it("returns the input unchanged when an id is missing", () => {
    expect(reorderRail(base, "sv_x", "sv_a")).toBe(base)
    expect(reorderRail(base, "sv_a", "sv_x")).toBe(base)
  })
})
