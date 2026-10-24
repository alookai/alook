import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, setupUser } from "@/test/react-dom-harness"
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
  it.each(["text", "forum"] as const)("activates %s rows and parent-aware child rows without navigating on hover/focus", async (type) => {
    const setActiveChannel = vi.fn()
    const onSelectForumThread = vi.fn()
    render(createElement(ChannelSidebarScope, {
      ...scopeProps([{ ...targetCategories[0], channels: [{ ...targetCategories[0].channels[0], type }] }]),
      setActiveChannel,
      onSelectForumThread,
      forumThreadsByParent: {
        "target-one": [{
          id: "thread-one", parentChannelId: "target-one", parentMessageId: "message-one",
          title: "Thread one", activityAt: "2026-09-25T00:00:00.000Z",
          expiresAt: "2026-09-28T00:00:00.000Z", unread: false,
        }],
      },
    }))
    const row = screen.getByTestId(tid.channelRow("target-one"))
    const child = screen.getByTestId(tid.forumSidebarThread("thread-one"))
    for (const element of [row, child]) {
      fireEvent.pointerEnter(element)
      fireEvent.focus(element)
    }
    expect(setActiveChannel).not.toHaveBeenCalled()
    expect(onSelectForumThread).not.toHaveBeenCalled()
    fireEvent.click(row)
    expect(setActiveChannel).toHaveBeenCalledExactlyOnceWith("target-one")
    const user = setupUser()
    await user.click(child)
    child.focus()
    await user.keyboard("{Enter}")
    expect(onSelectForumThread.mock.calls).toEqual([
      ["target-one", "thread-one"], ["target-one", "thread-one"],
    ])
  })

  it("includes both the primary tree and cached posts in the initial render", () => {
    const html = renderToString(createElement(ChannelSidebarRevealBoundary, {
      ...scopeProps(targetCategories),
      categories: targetCategories,
      primaryReady: true,
      forumProjectionMissing: false,
      forumThreadsByParent: {
        "target-one": [{ id: "thread-one", parentChannelId: "target-one", parentMessageId: "opener-one", title: "Cached post", activityAt: "2026-09-25T00:00:00.000Z", expiresAt: "2026-09-28T00:00:00.000Z", unread: false }],
      },
    }))
    expect(html).toContain(tid.channelRow("target-one"))
    expect(html).toContain(tid.forumSidebarThread("thread-one"))
    expect(html).not.toContain(tid.channelSidebarPending("target"))
  })

  it("keeps restored primary rows hidden while forum projection is pending", () => {
    render(createElement(ChannelSidebarRevealBoundary, {
      ...scopeProps(targetCategories),
      categories: targetCategories,
      primaryReady: true,
      forumProjectionMissing: true,
    }))

    expect(screen.queryByTestId(tid.channelRow("target-one"))).not.toBeInTheDocument()
    expect(screen.getByTestId(tid.channelSidebarPending("target"))).toBeInTheDocument()
  })

  it("waits for forum readiness when primary restoration finishes asynchronously", () => {
    const base = {
      ...scopeProps(targetCategories),
      categories: targetCategories,
      forumProjectionMissing: true,
    }
    const rendered = render(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: false,
    }))
    expect(screen.getByTestId(tid.channelSidebarPending("target"))).toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: true,
    }))

    expect(screen.queryByTestId(tid.channelRow("target-one"))).not.toBeInTheDocument()
    expect(screen.getByTestId(tid.channelSidebarPending("target"))).toBeInTheDocument()
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
    }))
    expect(screen.getByTestId(tid.channelSidebarPending("target"))).toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: true,
      forumProjectionMissing: true,
    }))
    expect(screen.getByTestId(tid.channelSidebarPending("target"))).toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: true,
      forumProjectionMissing: false,
    }))
    const owner = rendered.container.querySelector("[data-community-channel-tree-scope]")
    const scroll = screen.getByTestId(tid.channelSidebarScroll)
    expect(owner).toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: true,
      forumProjectionMissing: true,
    }))
    expect(rendered.container.querySelector("[data-community-channel-tree-scope]")).toBe(owner)
    expect(screen.getByTestId(tid.channelSidebarScroll)).toBe(scroll)
    expect(screen.queryByTestId(tid.channelSidebarPending("target"))).not.toBeInTheDocument()

    rendered.rerender(createElement(ChannelSidebarRevealBoundary, {
      ...base,
      primaryReady: true,
      forumProjectionMissing: false,
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

  it("keeps ordinary-member category actions and collapsed state while forum children reconcile", async () => {
    const rendered = render(createElement(ChannelSidebarScope, scopeProps(targetCategories)))
    const owner = rendered.container.querySelector("[data-community-channel-tree-scope]")!
    const header = screen.getByRole("button", { name: "Target category" })
    expect(header.tagName).toBe("DIV")
    expect(header).toHaveAttribute("tabindex", "0")
    expect(header).not.toHaveAttribute("aria-disabled", "true")
    expect(header).not.toHaveAttribute("aria-roledescription")
    expect(header).not.toHaveAttribute("aria-describedby")

    const user = setupUser()
    await user.click(header)
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
    expect(screen.getByRole("button", { name: "Target category" })).toBe(header)
    await user.click(header)
    expect(screen.getByTestId(tid.channelRow("target-one"))).not.toHaveAttribute("aria-disabled", "true")
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

vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))
