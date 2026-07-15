import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { hasChannelMenu, PendingChannelRow } from "./sortable-channel"
import type { Channel } from "./_types"

const noop = () => {}

describe("hasChannelMenu", () => {
  it("is false when no action handlers are provided", () => {
    expect(hasChannelMenu({})).toBe(false)
  })

  it("is true when any one action handler is provided", () => {
    expect(hasChannelMenu({ onEdit: noop })).toBe(true)
    expect(hasChannelMenu({ onManageMembers: noop })).toBe(true)
    expect(hasChannelMenu({ onDelete: noop })).toBe(true)
  })
})

describe("PendingChannelRow", () => {
  const ch: Channel = { id: "tmp_ch_x", name: "my-new-channel", active: false, unread: false, pending: true }
  const html = renderToStaticMarkup(createElement(PendingChannelRow, { ch }))

  it("renders the channel name", () => {
    expect(html).toContain("my-new-channel")
  })
  it("shows a spinner instead of an entity icon", () => {
    expect(html).toContain("animate-spin")
  })
  it("is non-interactive — disabled and cursor-default, no context menu", () => {
    expect(html).toContain("aria-disabled")
    expect(html).toContain("cursor-default")
  })
})
