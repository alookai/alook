import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { InboxPopover } from "./community-inbox-popover"
import type { UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import { tid } from "@/lib/community/testids"

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  TabsList: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  TabsTrigger: ({ children }: { children: React.ReactNode }) => React.createElement("button", null, children),
  TabsContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}))

function textOf(node: TestRenderer.ReactTestInstance | string | number): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  return node.children.map((child) => textOf(child)).join("")
}

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

  it("renders the authoritative opener title and passes parent/opener targets", async () => {
    const onOpenChannel = vi.fn()
    const onOpenThread = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(popover(onOpenChannel, onOpenThread))
    })

    const row = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button).includes("Full authoritative opener content"))
    expect(row).toBeDefined()
    await act(async () => row!.props.onClick())

    expect(onOpenThread).toHaveBeenCalledWith(
      unreadFixture()[0],
      unreadFixture()[0]!.channels[0],
      unreadFixture()[0]!.channels[0]!.children[0],
    )
    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it("passes reply-only children through the same exact thread-row callback", async () => {
    const onOpenChannel = vi.fn()
    const onOpenThread = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(popover(onOpenChannel, onOpenThread))
    })

    const row = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button).includes("Reply-only thread"))
    expect(row).toBeDefined()
    await act(async () => row!.props.onClick())

    expect(onOpenThread).toHaveBeenCalledWith(
      unreadFixture()[0],
      unreadFixture()[0]!.channels[0],
      unreadFixture()[0]!.channels[0]!.children[1],
    )
    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it("omits a structural parent button while retaining its child rows", async () => {
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.hasDirectUnread = false
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(InboxPopover, {
        unreads,
        unreadDms: [],
        mentions: [],
        marked: [],
        onOpenThread: vi.fn(),
      }))
    })
    expect(renderer.root.findAllByProps({
      "data-testid": tid.inboxUnreadChannel("f1"),
    })).toHaveLength(0)
    expect(renderer.root.findAllByProps({
      "data-testid": tid.inboxUnreadChild("p1"),
    })).toHaveLength(1)
  })

  it("hides only a projected direct parent and keeps sibling children", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(InboxPopover, {
        unreads: unreadFixture(),
        unreadDms: [],
        mentions: [],
        marked: [],
        onOpenThread: vi.fn(),
        isProjected: (target) => target?.kind === "channel-direct",
      }))
    })
    expect(renderer.root.findAllByProps({
      "data-testid": tid.inboxUnreadChannel("f1"),
    })).toHaveLength(0)
    expect(renderer.root.findAllByProps({
      "data-testid": tid.inboxUnreadChild("p1"),
    })).toHaveLength(1)
    expect(renderer.root.findAllByProps({
      "data-testid": tid.inboxUnreadChild("t1"),
    })).toHaveLength(1)
  })
})

describe("InboxPopover DM rows", () => {
  it("passes the complete DM summary to the open callback", async () => {
    const dm: UnreadDm = {
      channelId: "dm-new",
      otherUserId: "user-new",
      otherUserName: "New peer",
      otherUserDiscriminator: "2222",
      otherUserAvatar: "N",
      lastMessageAt: "2026-08-24T00:00:00.000Z",
    }
    const onOpenDm = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(InboxPopover, {
        unreads: [],
        unreadDms: [dm],
        mentions: [],
        marked: [],
        onOpenThread: vi.fn(),
        onOpenDm,
      }))
    })

    const row = renderer.root.findByProps({ "data-testid": tid.inboxUnreadDm(dm.channelId) })
    await act(async () => row.props.onClick())

    expect(onOpenDm).toHaveBeenCalledWith(dm)
  })
})
