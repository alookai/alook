import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import type { Category } from "@/lib/community/models/navigation"
import { tid } from "@/lib/community/testids"
import {
  ChannelSidebarRevealBoundary,
  ChannelSidebarScope,
} from "./channel-sidebar-tree-owner"

const targetCategories: Category[] = [{
  id: "target-category",
  name: "Target category",
  channels: [
    { id: "target-one", name: "target-one", active: true, unread: false },
  ],
}]

function scopeProps(categories: Category[] | null) {
  return {
    categories,
    scopeKey: "server:target",
    targetServerId: "target",
    serverId: "target",
    serverName: "Target",
    activeChannel: "target-one",
    setActiveChannel: vi.fn(),
    isAdmin: false,
    currentUserId: "viewer",
  }
}

describe("ChannelSidebarScope", () => {
  it("reveals restored rows immediately while forum projection is pending", () => {
    render(createElement(ChannelSidebarRevealBoundary, {
      ...scopeProps(targetCategories),
      categories: targetCategories,
      primaryReady: true,
      forumProjectionMissing: true,
      trustedRestoredPrimary: true,
    }))

    expect(screen.getByTestId(tid.channelRow("target-one"))).toBeInTheDocument()
    expect(screen.queryByTestId(tid.channelSidebarPending("target"))).not.toBeInTheDocument()
  })

  it("reveals asynchronously restored primary rows while forum projection stays pending", () => {
    const base = {
      ...scopeProps(targetCategories),
      categories: targetCategories,
      forumProjectionMissing: true,
    }
    const rendered = render(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: false,
      trustedRestoredPrimary: false,
    }))
    expect(screen.getByTestId(tid.channelSidebarPending("target"))).toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: true,
      trustedRestoredPrimary: true,
    }))

    expect(screen.getByTestId(tid.channelRow("target-one"))).toBeInTheDocument()
    expect(screen.queryByTestId(tid.channelSidebarPending("target"))).not.toBeInTheDocument()
  })

  it("keeps true-cold primary rows hidden until forum is ready, then preserves the DOM", () => {
    const base = {
      ...scopeProps(targetCategories),
      categories: targetCategories,
    }
    const rendered = render(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: false,
      forumProjectionMissing: true,
      trustedRestoredPrimary: false,
    }))
    expect(screen.getByTestId(tid.channelSidebarPending("target"))).toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: true,
      forumProjectionMissing: true,
      trustedRestoredPrimary: false,
    }))
    expect(screen.getByTestId(tid.channelSidebarPending("target"))).toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: true,
      forumProjectionMissing: false,
      trustedRestoredPrimary: false,
    }))
    const owner = rendered.container.querySelector("[data-community-channel-tree-scope]")
    const scroll = screen.getByTestId(tid.channelSidebarScroll)
    expect(owner).toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: true,
      forumProjectionMissing: true,
      trustedRestoredPrimary: false,
    }))
    expect(rendered.container.querySelector("[data-community-channel-tree-scope]")).toBe(owner)
    expect(screen.getByTestId(tid.channelSidebarScroll)).toBe(scroll)
    expect(screen.queryByTestId(tid.channelSidebarPending("target"))).not.toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: true,
      forumProjectionMissing: false,
      trustedRestoredPrimary: false,
    }))
    expect(rendered.container.querySelector("[data-community-channel-tree-scope]")).toBe(owner)
    expect(screen.getByTestId(tid.channelSidebarScroll)).toBe(scroll)
  })

  it("does not mount the tree owner until target data exists", () => {
    const rendered = render(createElement(ChannelSidebarScope, scopeProps(null)))

    expect(screen.getByTestId(tid.channelSidebarPending("target"))).toBeInTheDocument()
    expect(rendered.container.querySelector("[data-community-channel-tree-scope]"))
      .not.toBeInTheDocument()
    expect(rendered.container.querySelector(`[data-testid="${tid.channelRow("target-one")}"]`))
      .not.toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarScope, scopeProps(targetCategories)))

    expect(screen.queryByTestId(tid.channelSidebarPending("target"))).not.toBeInTheDocument()
    expect(rendered.container.querySelector("[data-community-channel-tree-scope]"))
      .toHaveAttribute("data-community-channel-tree-scope", "server:target")
    expect(screen.getByTestId(tid.channelRow("target-one"))).toBeInTheDocument()
    expect(rendered.container.textContent).not.toContain("source-one")
  })

  it("keeps cached rows and collapsed state while forum children reconcile", () => {
    const rendered = render(createElement(ChannelSidebarScope, scopeProps(targetCategories)))
    const owner = rendered.container.querySelector("[data-community-channel-tree-scope]")!

    fireEvent.click(screen.getByText("Target category"))
    expect(screen.queryByTestId(tid.channelRow("target-one"))).not.toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarScope, {
      ...scopeProps(targetCategories),
      forumThreadsByParent: {
        "target-one": [{
          id: "thread-one",
          parentChannelId: "target-one",
          parentMessageId: "message-one",
          title: "Thread one",
          activityAt: "2026-09-25T00:00:00.000Z",
          expiresAt: "2026-09-28T00:00:00.000Z",
          unread: false,
        }],
      },
    }))
    expect(rendered.container.querySelector("[data-community-channel-tree-scope]")).toBe(owner)
    expect(rendered.container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument()
    expect(screen.queryByTestId(tid.channelRow("target-one"))).not.toBeInTheDocument()
  })

  it("reconciles structural data to full data without replacing the scoped owner", () => {
    const rendered = render(createElement(ChannelSidebarScope, scopeProps(targetCategories)))
    const owner = rendered.container.querySelector("[data-community-channel-tree-scope]")!
    const fullCategories: Category[] = [{
      ...targetCategories[0],
      channels: [
        ...targetCategories[0].channels,
        { id: "target-two", name: "target-two", active: false, unread: false },
      ],
    }]

    rendered.rerender(createElement(ChannelSidebarScope, scopeProps(fullCategories)))

    expect(rendered.container.querySelector("[data-community-channel-tree-scope]")).toBe(owner)
    expect(screen.getByTestId(tid.channelRow("target-one"))).toBeInTheDocument()
    expect(screen.getByTestId(tid.channelRow("target-two"))).toBeInTheDocument()
  })
})
