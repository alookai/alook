import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { InboxPopover } from "./community-inbox-popover"
import type { UnreadServer } from "@/lib/community/models/inbox"

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
          openerMessageId: "m1",
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

function popover(onOpenChannel: ReturnType<typeof vi.fn>, onOpenForumThread: ReturnType<typeof vi.fn>) {
  return React.createElement(InboxPopover, {
    unreads: unreadFixture(),
    unreadDms: [],
    mentions: [],
    marked: [],
    onOpenChannel,
    onOpenForumThread,
  })
}

describe("InboxPopover forum post rows", () => {
  it("requires the forum-thread callback so opener-backed buttons cannot be inert", () => {
    expectTypeOf<Parameters<typeof InboxPopover>[0]>().toMatchTypeOf<{
      onOpenForumThread: (serverId: string, parentChannelId: string, childChannelId: string, openerMessageId: string) => void
    }>()
  })

  it("renders the authoritative opener title and passes parent/opener targets", async () => {
    const onOpenChannel = vi.fn()
    const onOpenForumThread = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(popover(onOpenChannel, onOpenForumThread))
    })

    const row = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button).includes("Full authoritative opener content"))
    expect(row).toBeDefined()
    await act(async () => row!.props.onClick())

    expect(onOpenForumThread).toHaveBeenCalledWith("s1", "f1", "p1", "m1")
    expect(onOpenChannel).not.toHaveBeenCalledWith("s1", "p1")
  })

  it("keeps reply-only child rows on the existing channel callback", async () => {
    const onOpenChannel = vi.fn()
    const onOpenForumThread = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(popover(onOpenChannel, onOpenForumThread))
    })

    const row = renderer.root
      .findAllByType("button")
      .find((button) => textOf(button).includes("Reply-only thread"))
    expect(row).toBeDefined()
    await act(async () => row!.props.onClick())

    expect(onOpenChannel).toHaveBeenCalledWith("s1", "t1", "f1")
    expect(onOpenForumThread).not.toHaveBeenCalled()
  })
})
