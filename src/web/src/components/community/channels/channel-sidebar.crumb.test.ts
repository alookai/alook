import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { ChannelSidebar } from "./channel-sidebar"
import type { ChannelTree } from "./use-channel-tree"

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

const renderLoading = () =>
  renderToStaticMarkup(
    createElement(ChannelSidebar, {
      tree: emptyTree,
      serverName: "Alpha",
      serverIcon: null,
      serverId: "srv_1",
      activeChannel: "",
      setActiveChannel: vi.fn(),
      loading: true,
      onInvitePopoverOpenChange: vi.fn(),
    }),
  )

const forumTree = {
  ...emptyTree,
  catOrder: ["cat_1"],
  order: {
    cat_1: [{
      id: "forum_1",
      name: "Forum",
      type: "forum",
      active: false,
      unread: false,
      muted: false,
    }],
  },
  catNames: { cat_1: "Channels" },
  catPrivate: { cat_1: false },
  catPending: { cat_1: false },
} as unknown as ChannelTree

const renderForum = (muted = false, activeThreadId = "post_2") => renderToStaticMarkup(
  createElement(ChannelSidebar, {
    tree: forumTree,
    serverName: "Alpha",
    activeChannel: "forum_1",
    setActiveChannel: vi.fn(),
    mutedChannels: muted ? { forum_1: true } : {},
    forumThreadsByParent: {
      forum_1: [
        {
          id: "post_1",
          parentChannelId: "forum_1",
          parentMessageId: "opener_1",
          title: "First post",
          activityAt: "2026-08-08T00:00:00.000Z",
          expiresAt: "2026-08-11T00:00:00.000Z",
          unread: true,
        },
        {
          id: "post_2",
          parentChannelId: "forum_1",
          parentMessageId: "opener_2",
          title: "Second post",
          activityAt: "2026-08-07T00:00:00.000Z",
          expiresAt: "2026-08-10T00:00:00.000Z",
          unread: false,
        },
      ],
    },
    activeThreadId,
    onSelectForumThread: vi.fn(),
  }),
)

describe("ChannelSidebar header", () => {
  it("keeps the channel list scrollable without reserving scrollbar width", () => {
    const html = render()
    expect(html).toContain('data-testid="community-channel-sidebar-scroll"')
    expect(html).toContain(
      "min-h-0 flex-1 overflow-y-auto px-2 py-4 thin-scrollbar scrollbar-none",
    )
    const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8")
    expect(css).toContain(".thin-scrollbar.scrollbar-none")
    expect(css).toContain("scrollbar-width: none")
  })

  it("keeps the same header action slot and scroll owner while loading", () => {
    const html = renderLoading()
    expect(html).toContain("flex min-h-0 min-w-0 flex-1 flex-col")
    expect(html).toContain(
      "min-h-0 flex-1 overflow-y-auto px-2 py-4 thin-scrollbar scrollbar-none",
    )
    expect(html).toContain("ml-auto size-7 shrink-0 rounded-md")
    expect(html).not.toContain("overflow-hidden")
  })

  it("renders the server name as the sole header identity marker (no duplicate ServerCrumb icon)", () => {
    const html = render()
    expect(html).toContain("Alpha")
    expect(html).not.toContain('aria-label="Alpha"')
  })

  it("renders forum children as non-sortable nested rows with one subtle 1.5px connector", () => {
    const html = renderForum()
    expect(html).toContain('data-testid="community-forum-sidebar-thread-post_1"')
    expect(html).toContain('data-testid="community-forum-sidebar-thread-post_2"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('stroke-width="1.5"')
    expect(html).toContain("text-muted-foreground/45")
    expect(html).toContain("H 11")
    expect(html).toContain("ml-4")
    expect(html).toContain("text-xs font-medium")
    expect(html).not.toContain("text-[13px]")
    expect(html).toContain("First post")
    expect(html).toContain("Second post")
    expect(html).toContain("bg-primary")
  })

  it("suppresses the child unread dot when its parent forum is muted", () => {
    expect(renderForum(true)).not.toContain("bg-primary")
  })

  it("uses the active child shape without treating route activation as read", () => {
    const html = renderForum(false, "post_1")
    expect(html).toContain('data-testid="community-forum-sidebar-thread-post_1"')
    expect(html).toContain('aria-current="page"')
    expect(html).not.toContain("bg-primary")
  })
})
