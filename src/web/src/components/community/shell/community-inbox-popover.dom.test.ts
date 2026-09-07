import React from "react"
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { InboxPopover } from "./community-inbox-popover"
import type { UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import { tid } from "@/lib/community/testids"

const mocks = vi.hoisted(() => ({ tabs: vi.fn() }))

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
    mocks.tabs(props)
    return React.createElement("tabs-root", null, children)
  },
  TabsList: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement("tabs-list", props, children),
  TabsTrigger: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement("tabs-trigger", props, children),
  TabsContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement("tabs-content", props, children),
}))

const textOf = (node: Node): string => node.textContent ?? ""

function unreadFixture(): UnreadServer[] {
  return [{
    serverId: "s1",
    serverName: "Server",
    channels: [{
      channelId: "f1",
      channelName: "Forum",
      type: "forum",
      lastMessageAt: "2026-08-07T10:00:00.000Z",
      mentionCount: 0,
      children: [
        {
          channelId: "p1",
          channelName: "Full authoritative opener content",
          type: "thread",
          lastMessageAt: "2026-08-07T10:00:00.000Z",
          mentionCount: 0,
          parentChannelId: "f1",
          openerMessageId: "m1",
          openerSeq: 7,
          openerUnread: true,
        },
        {
          channelId: "t1",
          channelName: "Reply-only thread",
          type: "thread",
          lastMessageAt: "2026-08-07T09:00:00.000Z",
          mentionCount: 0,
        },
      ],
    }],
  }]
}

function popover(onOpenChannel: ReturnType<typeof vi.fn>, onOpenThread: ReturnType<typeof vi.fn>) {
  return React.createElement(InboxPopover, {
    unreads: unreadFixture(),
    unreadDms: [],
    mentions: [],
    marked: [],
    hasProjectedUnreads: true,
    hasProjectedMentions: false,
    onOpenChannel,
    onOpenThread,
  })
}

describe("InboxPopover thread opener rows", () => {
  it("accepts the generic thread callback used by opener-backed buttons", () => {
    expectTypeOf<Parameters<typeof InboxPopover>[0]>().toMatchTypeOf<{
      onOpenThread?: (
        server: UnreadServer,
        parent: UnreadServer["channels"][number],
        child: UnreadServer["channels"][number]["children"][number],
      ) => void
    }>()
  })

  it("renders the authoritative opener title and passes parent/opener targets", () => {
    const onOpenChannel = vi.fn()
    const onOpenThread = vi.fn()
    const renderer = render(popover(onOpenChannel, onOpenThread))

    const row = Array.from(renderer.container.querySelectorAll("button"))
      .find((button) => textOf(button).includes("Full authoritative opener content"))
    expect(row).toBeDefined()
    fireEvent.click(row!)

    expect(onOpenThread).toHaveBeenCalledWith(
      unreadFixture()[0],
      unreadFixture()[0]!.channels[0],
      unreadFixture()[0]!.channels[0]!.children[0],
    )
    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it("passes reply-only children through the same exact thread-row callback", () => {
    const onOpenChannel = vi.fn()
    const onOpenThread = vi.fn()
    const renderer = render(popover(onOpenChannel, onOpenThread))

    const row = Array.from(renderer.container.querySelectorAll("button"))
      .find((button) => textOf(button).includes("Reply-only thread"))
    expect(row).toBeDefined()
    fireEvent.click(row!)

    expect(onOpenThread).toHaveBeenCalledWith(
      unreadFixture()[0],
      unreadFixture()[0]!.channels[0],
      unreadFixture()[0]!.channels[0]!.children[1],
    )
    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it("keeps a structural parent row when only its child is unread", () => {
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.hasDirectUnread = false
    const onOpenChannel = vi.fn()
    const renderer = render(React.createElement(InboxPopover, {
      unreads,
      unreadDms: [],
      mentions: [],
      marked: [],
      hasProjectedUnreads: true,
      hasProjectedMentions: false,
      onOpenChannel,
      onOpenThread: vi.fn(),
    }))
    const parentRows = renderer.queryAllByTestId(tid.inboxUnreadChannel("f1"))
    expect(parentRows).toHaveLength(1)
    expect(renderer.queryAllByTestId(tid.inboxUnreadChild("p1"))).toHaveLength(1)
    fireEvent.click(parentRows[0]!)
    expect(onOpenChannel).toHaveBeenCalledWith(
      unreads[0],
      unreads[0]!.channels[0],
      false,
    )
  })

  it("keeps one parent row with its children when both are unread", () => {
    const onOpenChannel = vi.fn()
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.mentionCount = 2
    const renderer = render(React.createElement(InboxPopover, {
      unreads,
      unreadDms: [],
      mentions: [],
      marked: [],
      hasProjectedUnreads: true,
      hasProjectedMentions: false,
      onOpenChannel,
      onOpenThread: vi.fn(),
    }))
    const parentRows = renderer.queryAllByTestId(tid.inboxUnreadChannel("f1"))
    expect(parentRows).toHaveLength(1)
    expect(renderer.queryAllByTestId(tid.inboxUnreadChild("p1"))).toHaveLength(1)
    expect(textOf(parentRows[0]!)).toContain("2")
    fireEvent.click(parentRows[0]!)
    expect(onOpenChannel).toHaveBeenCalledWith(
      unreads[0],
      unreads[0]!.channels[0],
      true,
    )
  })

  it("removes a structural parent after its only child is projected away", () => {
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.hasDirectUnread = false
    unreads[0]!.channels[0]!.children = unreads[0]!.channels[0]!.children.slice(0, 1)
    const renderer = render(React.createElement(InboxPopover, {
      unreads,
      unreadDms: [],
      mentions: [],
      marked: [],
      hasProjectedUnreads: true,
      hasProjectedMentions: false,
      onOpenThread: vi.fn(),
      isProjected: (target) => target?.kind === "thread",
    }))
    expect(renderer.queryAllByTestId(tid.inboxUnreadChannel("f1"))).toHaveLength(0)
    expect(renderer.queryAllByTestId(tid.inboxUnreadChild("p1"))).toHaveLength(0)
    expect(renderer.queryAllByTestId(tid.inboxUnreadChild("t1"))).toHaveLength(0)
  })

  it("retains a projected direct parent as structural while children remain", () => {
    const onOpenChannel = vi.fn()
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.mentionCount = 2
    const renderer = render(React.createElement(InboxPopover, {
      unreads,
      unreadDms: [],
      mentions: [],
      marked: [],
      hasProjectedUnreads: true,
      hasProjectedMentions: false,
      onOpenChannel,
      onOpenThread: vi.fn(),
      isProjected: (target) => target?.kind === "channel-direct",
    }))
    const parentRows = renderer.queryAllByTestId(tid.inboxUnreadChannel("f1"))
    expect(parentRows).toHaveLength(1)
    expect(renderer.queryAllByTestId(tid.inboxUnreadChild("p1"))).toHaveLength(1)
    expect(renderer.queryAllByTestId(tid.inboxUnreadChild("t1"))).toHaveLength(1)
    expect(textOf(parentRows[0]!)).not.toContain("2")
    fireEvent.click(parentRows[0]!)
    expect(onOpenChannel).toHaveBeenCalledWith(
      unreads[0],
      unreads[0]!.channels[0],
      false,
    )
  })
})

describe("InboxPopover DM rows", () => {
  it("passes the complete DM summary to the open callback", () => {
    const dm: UnreadDm = {
      channelId: "dm-new",
      otherUserId: "user-new",
      otherUserName: "New peer",
      otherUserDiscriminator: "2222",
      otherUserAvatar: "N",
      lastMessageAt: "2026-08-24T00:00:00.000Z",
    }
    const onOpenDm = vi.fn()
    const renderer = render(React.createElement(InboxPopover, {
      unreads: [],
      unreadDms: [dm],
      mentions: [],
      marked: [],
      hasProjectedUnreads: true,
      hasProjectedMentions: false,
      onOpenThread: vi.fn(),
      onOpenDm,
    }))

    fireEvent.click(renderer.getByTestId(tid.inboxUnreadDm(dm.channelId)))

    expect(onOpenDm).toHaveBeenCalledWith(dm)
  })
})

describe("InboxPopover responsive continuity", () => {
  it("keeps active tab controlled and reports independent scroll offsets", () => {
    const onActiveTabChange = vi.fn()
    const onMarkedTabSelected = vi.fn()
    let mentionsOffset = 73
    const onScrollOffsetChange = vi.fn((tab: string, scrollTop: number) => {
      if (tab === "mentions") mentionsOffset = scrollTop
    })
    const renderer = render(React.createElement(InboxPopover, {
      unreads: [],
      unreadDms: [],
      mentions: [],
      marked: [],
      hasProjectedUnreads: false,
      hasProjectedMentions: false,
      activeTab: "mentions",
      onActiveTabChange,
      onMarkedTabSelected,
      getScrollOffset: (tab) => tab === "mentions" ? mentionsOffset : 0,
      onScrollOffsetChange,
      surface: "mobile",
    }))

    const tabs = mocks.tabs.mock.calls.at(-1)![0] as {
      className: string
      onValueChange: (value: string) => void
      value: string
    }
    expect(tabs.value).toBe("mentions")
    expect(tabs.className).toContain("h-full")
    tabs.onValueChange("marked")
    expect(onActiveTabChange).toHaveBeenCalledWith("marked")
    expect(onMarkedTabSelected).toHaveBeenCalledOnce()

    const mentionsScroll = renderer.getByTestId(tid.inboxTabScroll("mentions"))
    mentionsScroll.scrollTop = 91
    fireEvent.scroll(mentionsScroll)
    expect(onScrollOffsetChange).toHaveBeenCalledWith("mentions", 91)
    onScrollOffsetChange.mockClear()
    mentionsScroll.scrollTop = 42
    fireEvent.scroll(mentionsScroll)
    expect(onScrollOffsetChange).not.toHaveBeenCalled()
    fireEvent.wheel(mentionsScroll)
    fireEvent.scroll(mentionsScroll)
    expect(onScrollOffsetChange).toHaveBeenCalledWith("mentions", 42)
    expect(renderer.getByTestId(tid.inboxTabList)).toBeInTheDocument()
    expect(renderer.container.querySelector("h2")?.parentElement?.className)
      .toBe("flex items-center gap-2 px-3 pt-4")
  })
})
