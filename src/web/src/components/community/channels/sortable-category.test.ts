import { describe, it, expect } from "vitest"
import { hasCategoryMenu } from "./sortable-category"

const noop = () => {}

describe("hasCategoryMenu", () => {
  it("is false when no action handlers are provided", () => {
    expect(hasCategoryMenu({})).toBe(false)
  })

  it("is true when any one action handler is provided", () => {
    expect(hasCategoryMenu({ onAddChannel: noop })).toBe(true)
    expect(hasCategoryMenu({ onSettings: noop })).toBe(true)
    expect(hasCategoryMenu({ onDelete: noop })).toBe(true)
  })
})
