import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import type { Category } from "@/lib/community/models/navigation"
import { tid } from "@/lib/community/testids"
import { ChannelSidebarScope } from "./channel-sidebar-tree-owner"

const targetCategories: Category[] = [{
  id: "target-category",
  name: "Target category",
  channels: [
    { id: "target-one", name: "target-one", active: true, unread: false },
  ],
}]

function scopeProps(categories: Category[] | null, loading = false) {
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
    loading,
  }
}

describe("ChannelSidebarScope", () => {
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

  it("keeps the same owner and collapsed state through inner forum loading", () => {
    const rendered = render(createElement(ChannelSidebarScope, scopeProps(targetCategories)))
    const owner = rendered.container.querySelector("[data-community-channel-tree-scope]")!

    fireEvent.click(screen.getByText("Target category"))
    expect(screen.queryByTestId(tid.channelRow("target-one"))).not.toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarScope, scopeProps(targetCategories, true)))
    expect(rendered.container.querySelector("[data-community-channel-tree-scope]")).toBe(owner)
    expect(rendered.container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarScope, scopeProps(targetCategories, false)))
    expect(rendered.container.querySelector("[data-community-channel-tree-scope]")).toBe(owner)
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
