import { describe, it, expect } from "vitest"
import { Hash, ListChevronsUpDown } from "lucide-react"
import { getEntityIcon } from "./entity-icon"
import { ChannelIcon } from "./channels/channel-icon"

describe("getEntityIcon", () => {
  it("text and undefined → ChannelIcon (the custom slash glyph)", () => {
    expect(getEntityIcon("text")).toBe(ChannelIcon)
    expect(getEntityIcon(undefined)).toBe(ChannelIcon)
  })

  it("forum → ListChevronsUpDown", () => {
    expect(getEntityIcon("forum")).toBe(ListChevronsUpDown)
  })

  it("thread → Hash", () => {
    expect(getEntityIcon("thread")).toBe(Hash)
  })
})
