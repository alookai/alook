import { describe, it, expect } from "vitest"
import { ListChevronsUpDown, MessagesSquare } from "lucide-react"
import { getEntityIcon } from "./entity-icon"
import { ChannelIcon } from "./channel-icon"

describe("getEntityIcon", () => {
  it("text and undefined → ChannelIcon (the custom slash glyph)", () => {
    expect(getEntityIcon("text")).toBe(ChannelIcon)
    expect(getEntityIcon(undefined)).toBe(ChannelIcon)
  })

  it("forum → ListChevronsUpDown", () => {
    expect(getEntityIcon("forum")).toBe(ListChevronsUpDown)
  })

  it("thread and forum_post → MessagesSquare", () => {
    expect(getEntityIcon("thread")).toBe(MessagesSquare)
    expect(getEntityIcon("forum_post")).toBe(MessagesSquare)
  })
})
