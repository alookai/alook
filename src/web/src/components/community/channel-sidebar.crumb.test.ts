import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// The header's ServerCrumb is gated on the mobile breakpoint — mock the hook
// so each case renders deterministically without a DOM/matchMedia.
const isMobile = vi.fn<() => boolean>()
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => isMobile() }))

import { ChannelSidebar } from "./channel-sidebar"
import type { ChannelTree } from "./use-channel-tree"

// Minimal empty tree — the header renders regardless of channel content.
const emptyTree = {
  collapsed: new Set<string>(),
  catOrder: [],
  order: {},
  catNames: {},
  catPrivate: {},
  catPending: {},
  catCreators: {},
  toggleCat: vi.fn(),
  removeChannel: vi.fn(),
  renameChannel: vi.fn(),
  markRead: vi.fn(),
  renameCategory: vi.fn(),
  onDragOver: vi.fn(),
  onDragEnd: vi.fn(),
} as unknown as ChannelTree

const render = () =>
  renderToStaticMarkup(
    createElement(ChannelSidebar, {
      tree: emptyTree,
      serverName: "Alpha",
      serverIcon: null,
      serverId: "srv_1",
      activeChannel: "",
      setActiveChannel: vi.fn(),
      onOpenSettings: vi.fn(),
    }),
  )

describe("ChannelSidebar header ServerCrumb", () => {
  it("renders the server crumb on mobile (rail is hidden — sole identity marker)", () => {
    isMobile.mockReturnValue(true)
    // ServerCrumb is the only element that emits aria-label/title with the name.
    expect(render()).toContain('aria-label="Alpha"')
  })

  it("omits the server crumb on desktop (rail already shows the icon)", () => {
    isMobile.mockReturnValue(false)
    const html = render()
    expect(html).not.toContain('aria-label="Alpha"')
    // The server name itself still renders in the header text.
    expect(html).toContain("Alpha")
  })
})
