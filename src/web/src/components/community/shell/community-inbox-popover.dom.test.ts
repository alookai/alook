import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { InboxPopover } from "./community-inbox-popover"
import type { InboxTodo, Marked, Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import { buildDecisionCardEmbed, DecisionCardInputSchema } from "@alook/shared"
import { tid } from "@/lib/community/testids"
import { ApiError } from "@/lib/errors"
import type { CommunityProfile } from "@/lib/community/models/people"

vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))

const mocks = vi.hoisted(() => ({
  tabs: vi.fn(),
  profiles: new Map<string, CommunityProfile>(),
  categories: new Map<string, { name: string }>(),
  channels: new Map<string, { name: string; type: "forum"; categoryId: string }>(),
  dms: [] as Array<{ id: string; userId: string; name: string; discriminator?: string; avatar: string }>,
}))

vi.mock("@/lib/community-db/projections", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useCanonicalProfilesByUserId: () => mocks.profiles,
  useCanonicalCommunityProfile: (id: string | undefined) => id ? mocks.profiles.get(id) : undefined,
  useCanonicalCategoriesById: () => mocks.categories,
  useCanonicalChannelsById: () => mocks.channels,
  useDmProjection: () => mocks.dms,
}))

beforeEach(() => {
  mocks.profiles.clear()
  mocks.categories.clear()
  mocks.channels.clear()
  mocks.dms.length = 0
})

function renderInboxMessages(element: React.ReactElement) {
  return render(React.createElement(QueryClientProvider, { client: new QueryClient() }, element))
}

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

describe("Inbox channel cards", () => {
  it("keeps two unread children in separate collapsed cards without an unread parent", () => {
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.hasDirectUnread = false
    const view = render(React.createElement(InboxPopover, {
      unreads, unreadDms: [], mentions: [], marked: [], hasProjectedUnreads: true, hasProjectedMentions: false,
      onOpenThread: vi.fn(),
    }))
    expect(view.container.querySelectorAll('[data-testid^="community-inbox-unread-card-"]')).toHaveLength(2)
    expect(view.queryByTestId("community-inbox-unread-card-f1")).toBeNull()
    for (const id of ["p1", "t1"]) {
      const card = view.getByTestId(`community-inbox-unread-card-${id}`)
      expect(card.textContent).toContain("Server")
      expect(card.textContent).toContain("Forum")
      expect(card.querySelector('[aria-expanded="false"]')).not.toBeNull()
    }
    expect(view.container.querySelector('tabs-trigger[value="mentions"]')).toBeNull()
    expect(view.container.querySelector('tabs-trigger[value="marked"]')).not.toBeNull()
  })

  it("expands and collapses only the selected channel without reading or navigating", () => {
    const renderUnreadMessages = vi.fn(({ channelId }: { channelId: string }) => React.createElement("div", null, `unread ${channelId}`))
    const onMarkChannelRead = vi.fn()
    const onOpenThread = vi.fn()
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.children[1]!.unreadCount = 2
    const props = { unreads, unreadDms: [], mentions: [], marked: [], hasProjectedUnreads: true, hasProjectedMentions: false,
      renderUnreadMessages, onMarkChannelRead, onOpenThread }
    const view = render(React.createElement(InboxPopover, props))
    const disclosure = view.getByRole("button", { name: "Show unread messages in Reply-only thread" })
    const artwork = disclosure.querySelector('[data-slot="inbox-action-visual"]')!
    const chevron = disclosure.querySelector("svg")
    expect(disclosure).toHaveAccessibleDescription("2 unread messages")
    expect(disclosure).toHaveAttribute("data-variant", "unread")
    expect(view.getByLabelText("2 unread messages")).toHaveTextContent("2")
    expect(artwork).toHaveAttribute("data-unread", "true")
    expect(renderUnreadMessages).not.toHaveBeenCalled()
    fireEvent.click(disclosure)
    expect(view.getByRole("button", { name: "Hide unread messages in Reply-only thread" })).toBe(disclosure)
    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    expect(disclosure).toHaveAttribute("data-variant", "ghost")
    expect(disclosure).toHaveAccessibleDescription("")
    expect(artwork).toHaveAttribute("data-unread", "false")
    expect(disclosure.querySelector("svg")).toBe(chevron)
    expect(view.queryByLabelText("2 unread messages")).toBeNull()
    expect(view.getByText("unread t1")).toBeDefined()
    expect(view.queryByText("unread p1")).toBeNull()
    const updated = structuredClone(unreads)
    updated[0]!.channels[0]!.children[1]!.unreadCount = 4
    view.rerender(React.createElement(InboxPopover, { ...props, unreads: updated }))
    expect(view.queryByLabelText("4 unread messages")).toBeNull()
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAccessibleDescription("4 unread messages")
    expect(disclosure).toHaveAttribute("data-variant", "unread")
    expect(view.getByLabelText("4 unread messages")).toHaveTextContent("4")
    expect(view.queryByText("unread t1")).toBeNull()
    expect(onMarkChannelRead).not.toHaveBeenCalled()
    expect(onOpenThread).not.toHaveBeenCalled()
  })

  it("retries the selected channel's captured watermark without reading a later arrival", async () => {
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.children[0]!.lastUnreadSeq = 23
    const onMarkChannelRead = vi.fn().mockResolvedValue(undefined)
    const onOpenThread = vi.fn()
    const props = { unreads, unreadDms: [], mentions: [], marked: [], hasProjectedUnreads: true, hasProjectedMentions: false, onMarkChannelRead, onOpenThread }
    const view = render(React.createElement(InboxPopover, props))
    fireEvent.click(view.getByRole("button", { name: "Mark Full authoritative opener content read" }))
    expect(onMarkChannelRead).toHaveBeenCalledExactlyOnceWith("p1", 23)
    const pending = structuredClone(unreads)
    pending[0]!.channels[0]!.children.shift()
    view.rerender(React.createElement(InboxPopover, { ...props, unreads: pending }))
    expect(view.queryByTestId(tid.inboxUnreadCard("p1"))).toBeNull()
    const newer = structuredClone(unreads)
    newer[0]!.channels[0]!.children[0]!.lastUnreadSeq = 24
    view.rerender(React.createElement(InboxPopover, {
      ...props,
      unreads: newer,
      channelReadActions: new Map([["p1", { throughSeq: 23, status: "error" }]]),
    }))
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Retry marking Full authoritative opener content read" })))
    expect(onMarkChannelRead.mock.calls).toEqual([["p1", 23], ["p1", 23]])
    expect(onOpenThread).not.toHaveBeenCalled()
  })
})

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
  it.each([undefined, 0, 3, 123456])("shows a positive DM count on its disclosure: %s", (unreadCount) => {
    mocks.profiles.set("peer", { id: "peer", name: "Mika", discriminator: "0042" })
    const dm: UnreadDm = { channelId: "dm1", otherUserId: "peer", otherUserName: "Mika", otherUserDiscriminator: "0042", otherUserAvatar: "M", otherUserAvatarVersion: 0, lastMessageAt: "2026-10-24T00:00:00Z", unreadCount }
    const onOpenDm = vi.fn()
    const renderer = render(React.createElement(InboxPopover, {
      unreads: [], unreadDms: [dm], mentions: [], marked: [], hasProjectedUnreads: true, hasProjectedMentions: false, onOpenDm,
    }))
    const row = renderer.getByTestId(tid.inboxUnreadDm("dm1"))
    expect(row.querySelector('[title="Mika"]')?.textContent).toBe("Mika#0042")
    const disclosure = renderer.getByTestId(tid.inboxToggleChannel("dm1"))
    if (unreadCount) {
      expect(disclosure).toHaveAccessibleDescription(`${unreadCount} unread messages`)
      expect(disclosure).toHaveAttribute("data-variant", "unread")
      expect(disclosure).toHaveTextContent(String(unreadCount))
      if (unreadCount > 99) {
        expect(disclosure.querySelector('[data-slot="inbox-unread-ellipsis"]')).not.toBeNull()
      } else {
        expect(disclosure.querySelector('[data-slot="inbox-unread-ellipsis"]')).toBeNull()
      }
      expect(row).not.toHaveTextContent(String(unreadCount))
    } else {
      expect(disclosure).toHaveAccessibleDescription("")
      expect(disclosure.querySelector("svg")).not.toBeNull()
    }
    expect(row).not.toHaveTextContent("Direct Messages")
    expect(row.querySelector(".text-xs")?.textContent).toBe("#0042")
    fireEvent.click(row)
    expect(onOpenDm).toHaveBeenCalledExactlyOnceWith(dm)
  })

  it("shows server identity and an independent disclosure on every channel card", () => {
    const renderer = render(popover(vi.fn(), vi.fn()))
    const icon = renderer.getAllByRole("img", { name: "Server" })[0]!
    expect(icon.style.width).toBe("32px")
    expect(icon.style.height).toBe("32px")
    const unreads = renderer.getByTestId(tid.inboxTabScroll("unreads"))
    expect(unreads.querySelectorAll("button[aria-expanded=\"false\"]")).toHaveLength(3)
    const check = renderer.getByTestId(tid.inboxMarkChannelRead("f1"))
    const arrow = renderer.getByTestId(tid.inboxToggleChannel("f1"))
    expect(check).toHaveAttribute("data-variant", "secondary")
    expect(arrow).toHaveAttribute("data-variant", "ghost")
    expect(check).toHaveAttribute("data-size", "icon")
    expect(arrow).toHaveAttribute("data-size", "icon")
    expect(check.querySelector("svg")).not.toBeNull()
    expect(arrow.querySelector("svg")).not.toBeNull()
    expect(arrow.querySelector('[data-slot="inbox-action-visual"]')).toHaveAttribute("aria-hidden", "true")
    expect(check.nextElementSibling).toBe(arrow)
    expect(icon.closest("header")).toBe(arrow.closest("header"))
    expect(icon.nextElementSibling?.matches("svg")).toBe(false)
    const identity = renderer.getByTestId(tid.inboxUnreadChannel("f1"))
    expect(identity.querySelector("span.size-4 > svg.size-3\\.5")).not.toBeNull()
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

  it("opens the parent from forum title text and keeps independent preview controls", () => {
    const unreads = unreadFixture()
    const server = unreads[0]!
    const parent = server.channels[0]!
    const firstOpener = {
      ...parent.children[0]!,
      openerMessageId: "opener-1",
      openerSeq: 7,
      openerUnread: true as const,
    }
    parent.children = []
    parent.forumOpeners = [firstOpener]
    const openChannel = vi.fn()
    const openThread = vi.fn()
    const openLink = vi.fn()
    const markChannelRead = vi.fn()
    const view = render(React.createElement("div", { tabIndex: 0 }, React.createElement(InboxPopover, {
      unreads, unreadDms: [], mentions: [], marked: [],
      hasProjectedUnreads: true, hasProjectedMentions: false,
      onOpenChannel: openChannel, onOpenThread: openThread, onMarkChannelRead: markChannelRead,
      renderUnreadMessages: ({ openForumPosts }) => React.createElement(
        "div", null,
        React.createElement("span", null, "First post"),
        React.createElement("button", { onClick: openForumPosts?.get("opener-1") }, "Open first thread"),
        React.createElement("a", {
          href: "/help",
          onClick: (event: React.MouseEvent) => { event.preventDefault(); openLink() },
        }, "Reference"),
      ),
    })))
    fireEvent.click(view.getByTestId(tid.inboxToggleChannel(parent.channelId)))
    expect(openThread).not.toHaveBeenCalled()
    expect(markChannelRead).not.toHaveBeenCalled()
    expect(view.queryByTestId(tid.inboxUnreadChild(firstOpener.channelId))).toBeNull()
    const title = view.getByText("First post", { exact: true })
    fireEvent.click(title)
    expect(openChannel).toHaveBeenCalledExactlyOnceWith(server, parent, true)
    expect(openThread).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole("button", { name: "Open first thread" }))
    expect(openThread).toHaveBeenCalledExactlyOnceWith(server, parent, firstOpener)
    fireEvent.click(view.getByRole("link", { name: "Reference" }))
    expect(openLink).toHaveBeenCalledOnce()
    fireEvent.click(title, { ctrlKey: true })
    const selection = title.ownerDocument.getSelection()!
    const range = title.ownerDocument.createRange()
    range.selectNodeContents(title)
    selection.addRange(range)
    fireEvent.click(title)
    selection.removeAllRanges()
    expect(openChannel).toHaveBeenCalledTimes(1)
    expect(markChannelRead).not.toHaveBeenCalled()
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

  it("keeps parent context in unread child cards without creating an unread parent", () => {
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
    expect(parentRows).toHaveLength(0)
    expect(renderer.queryAllByTestId(tid.inboxUnreadChild("p1"))).toHaveLength(1)
    expect(renderer.getByTestId(tid.inboxUnreadCard("p1"))).toHaveTextContent("Server › Forum")
    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it("keeps one parent row with its children when both are unread", () => {
    const onOpenChannel = vi.fn()
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.mentionCount = 2
    unreads[0]!.channels[0]!.unreadCount = 3
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
    expect(renderer.getByTestId(tid.inboxToggleChannel("f1"))).toHaveAccessibleDescription("3 unread messages")
    fireEvent.click(parentRows[0]!)
    expect(onOpenChannel).toHaveBeenCalledWith(
      unreads[0],
      unreads[0]!.channels[0],
      true,
    )
  })

  it("does not let a navigation tombstone hide a new child generation", () => {
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
    }))
    expect(renderer.queryAllByTestId(tid.inboxUnreadChannel("f1"))).toHaveLength(0)
    expect(renderer.queryAllByTestId(tid.inboxUnreadChild("p1"))).toHaveLength(1)
    expect(renderer.queryAllByTestId(tid.inboxUnreadChild("t1"))).toHaveLength(0)
  })

  it("renders canonical direct and child truth without tombstone filtering", () => {
    const onOpenChannel = vi.fn()
    const unreads = unreadFixture()
    const parent = unreads[0]!.channels[0]!
    parent.mentionCount = 2
    parent.unreadCount = 3
    parent.children[0]!.unreadCount = 5
    parent.children[1]!.unreadCount = 1
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
    const openerRows = renderer.queryAllByTestId(tid.inboxUnreadChild("p1"))
    expect(parentRows).toHaveLength(1)
    expect(openerRows).toHaveLength(1)
    expect(renderer.queryAllByTestId(tid.inboxUnreadChild("t1"))).toHaveLength(1)
    expect(textOf(parentRows[0]!)).toContain("Forum")
    expect(textOf(openerRows[0]!)).toContain("Full authoritative opener content")
    expect(renderer.getByTestId(tid.inboxToggleChannel("f1"))).toHaveAccessibleDescription("3 unread messages")
    expect(renderer.getByTestId(tid.inboxToggleChannel("p1"))).toHaveAccessibleDescription("5 unread messages")
    expect(renderer.getByTestId(tid.inboxToggleChannel("t1"))).toHaveAccessibleDescription("1 unread message")
    fireEvent.click(parentRows[0]!)
    expect(onOpenChannel).toHaveBeenCalledWith(
      unreads[0],
      unreads[0]!.channels[0],
      true,
    )
  })
})

describe("InboxPopover channel mentions", () => {
  it("opens the channel header's destination from a mention preview", () => {
    mocks.profiles.set("author", { id: "author", name: "Alice", discriminator: "0042", avatar: "A" })
    const onOpenChannel = vi.fn()
    const onMarkChannelRead = vi.fn()
    const mention: Mention = { id: "mention-1", server: "Server", channel: "Forum", channelId: "f1", serverId: "s1", m: { id: "message-1", seq: 7, type: "chat", authorId: "author", content: "Hello there" } }
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.lastUnreadSeq = 7
    const renderer = renderInboxMessages(React.createElement(InboxPopover, {
      unreads, unreadDms: [], mentions: [mention], marked: [],
      hasProjectedUnreads: true, hasProjectedMentions: true, onOpenChannel, onMarkChannelRead,
    }))
    expect(renderer.queryByText("Hello there")).toBeNull()
    fireEvent.click(renderer.getByRole("button", { name: "Show unread messages in Forum" }))
    expect(renderer.getByText("Alice")).toBeDefined()
    expect(renderer.getByTestId(tid.inboxUnreadMessages("f1"))).toBeDefined()
    const preview = renderer.getByTestId(tid.inboxMention(mention.id))
    const avatar = preview.querySelector<HTMLElement>('[data-slot="avatar"]')
    expect(avatar).toHaveStyle({ width: "32px", height: "32px" })
    expect(preview.querySelector("[data-message-renderer]")).not.toBeNull()
    fireEvent.click(renderer.getByText("Hello there"))
    expect(onOpenChannel).toHaveBeenCalledExactlyOnceWith(unreads[0], unreads[0]!.channels[0], true)
    expect(onMarkChannelRead).not.toHaveBeenCalled()
  })
})

it("uses the same location and renderer for separate saved messages in one channel", () => {
  mocks.categories.set("release", { name: "Release notes" })
  mocks.channels.set("f1", { name: "Forum", type: "forum", categoryId: "release" })
  const marked: Marked[] = ["First", "Second"].map((name, index) => ({
    id: `mark-${index}`,
    server: "Server",
    serverId: "s1",
    channel: "Forum",
    channelId: "f1",
    m: { id: `message-${index}`, seq: index + 1, type: "chat", authorName: "Mika", content: `${name} saved message` },
  }))
  const onUnmark = vi.fn()
  const onOpenMarked = vi.fn()
  const view = renderInboxMessages(React.createElement(InboxPopover, {
    unreads: unreadFixture(), unreadDms: [], mentions: [], marked,
    hasProjectedUnreads: true, hasProjectedMentions: false, onUnmark, onOpenMarked,
  }))
  expect(view.getByTestId(tid.inboxUnreadCard("f1"))).toHaveTextContent("Server › Release notes")
  expect(view.getByTestId(tid.inboxUnreadCard("p1"))).toHaveTextContent("Server › Forum")
  for (const row of marked) {
    const card = view.getByTestId(tid.inboxMarkedCard(row.id))
    const header = card.querySelector("header")!
    const trash = view.getByTestId(tid.inboxUnmark(row.m.id))
    expect(header).toHaveTextContent("Server › Release notes")
    expect(header.lastElementChild).toBe(trash)
    expect(header.querySelector("[aria-expanded]")).toBeNull()
    expect(card.querySelector("[data-message-renderer]")).toHaveTextContent(row.m.content!)
  }
  fireEvent.click(view.getByTestId(tid.inboxUnmark(marked[1]!.m.id)))
  expect(onUnmark).toHaveBeenCalledExactlyOnceWith(marked[1]!.m.id)
  expect(onOpenMarked).not.toHaveBeenCalled()
  fireEvent.click(view.getByText("First saved message"))
  expect(onOpenMarked).toHaveBeenCalledExactlyOnceWith(marked[0])
})

describe("InboxPopover friend requests", () => {
  const friendRequest = {
    row: {
      id: "fr_1",
      userId: "u_friend",
      name: "Ada",
      avatar: "A",
      avatarVersion: 1,
      createdAt: "2026-09-12T01:00:00Z",
    },
  }

  it.each([
    { requests: true, dms: false, servers: false, separators: 0 },
    { requests: false, dms: true, servers: false, separators: 0 },
    { requests: false, dms: false, servers: true, separators: 0 },
    { requests: true, dms: true, servers: false, separators: 1 },
    { requests: true, dms: false, servers: true, separators: 1 },
    { requests: false, dms: true, servers: true, separators: 1 },
    { requests: true, dms: true, servers: true, separators: 2 },
  ])("keeps requests and nonempty channel cards independent: $requests/$dms/$servers", ({ requests, dms, servers }) => {
    const renderer = render(React.createElement(InboxPopover, {
      friendRequests: requests ? [friendRequest] : [],
      unreads: servers ? unreadFixture() : [],
      unreadDms: dms ? [{ channelId: "dm1", otherUserId: "peer", otherUserName: "Peer", otherUserDiscriminator: "0042", otherUserAvatar: "P", otherUserAvatarVersion: 0, lastMessageAt: "2026-10-24T00:00:00Z" }] : [],
      mentions: [], marked: [], hasProjectedUnreads: dms || servers, hasProjectedMentions: false,
    }))
    expect(renderer.queryAllByTestId(tid.inboxFriendRequest(friendRequest.row.id))).toHaveLength(requests ? 1 : 0)
    expect(renderer.getByTestId(tid.inboxTabScroll("unreads")).querySelectorAll('[data-testid^="community-inbox-unread-card-"]')).toHaveLength((dms ? 1 : 0) + (servers ? 3 : 0))
  })

  it("renders requests before DMs and servers with sibling navigation/actions", () => {
    mocks.profiles.set("u_friend", { id: "u_friend", name: "Ada", discriminator: "0001" })
    const onOpenFriendRequests = vi.fn()
    const onAcceptFriendRequest = vi.fn()
    const renderer = render(React.createElement(InboxPopover, {
      friendRequests: [friendRequest],
      unreads: unreadFixture(),
      unreadDms: [{
        channelId: "dm1",
        otherUserId: "u2",
        otherUserName: "Grace",
        otherUserDiscriminator: "0001",
        otherUserAvatar: "G",
        otherUserAvatarVersion: 1,
        lastMessageAt: "2026-09-12T00:00:00Z",
      }],
      mentions: [],
      marked: [],
      hasProjectedUnreads: true,
      hasProjectedMentions: false,
      onOpenFriendRequests,
      onAcceptFriendRequest,
      onOpenThread: vi.fn(),
    }))
    const text = renderer.container.textContent ?? ""
    expect(text).not.toContain("sent you a friend request")
    const requestTitle = renderer.getByText("Friend requests — 1")
    const dm = renderer.getByTestId(tid.inboxUnreadDm("dm1"))
    const channel = renderer.getByTestId(tid.inboxUnreadChannel("f1"))
    expect(requestTitle.compareDocumentPosition(dm)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(dm.compareDocumentPosition(channel)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    const open = renderer.getByTestId(tid.inboxFriendRequestOpen("fr_1"))
    expect(open.textContent).toBe("Ada#0001")
    expect(open.querySelector(".text-xs")?.textContent).toBe("#0001")
    const accept = renderer.getByTestId(tid.inboxFriendRequestAccept("fr_1"))
    const reject = renderer.getByTestId(tid.inboxFriendRequestReject("fr_1"))
    for (const action of [accept, reject]) {
      expect(action).toHaveAttribute("data-variant", "ghost")
      expect(action.querySelector('[data-slot="inbox-action-visual"]')).not.toBeNull()
    }
    expect(open.contains(accept)).toBe(false)
    fireEvent.click(accept)
    expect(onAcceptFriendRequest).toHaveBeenCalledWith(friendRequest)
    expect(onOpenFriendRequests).not.toHaveBeenCalled()
    fireEvent.click(open)
    expect(onOpenFriendRequests).toHaveBeenCalledTimes(1)
  })

  it("keeps request-only state out of Caught up while Mark all stays disabled", () => {
    const renderer = render(React.createElement(InboxPopover, {
      friendRequests: [friendRequest],
      unreads: [],
      unreadDms: [],
      mentions: [],
      marked: [],
      hasProjectedUnreads: false,
      hasProjectedMentions: false,
      onMarkAllRead: vi.fn(),
    }))
    expect(renderer.queryByText("Caught up")).toBeNull()
    expect(renderer.getByRole("button", { name: "Mark all read" })).toBeDisabled()
  })

  it("renders a pending tombstone and an accessible retryable error", () => {
    const onRetryFriendRequest = vi.fn()
    const renderer = render(React.createElement(InboxPopover, {
      friendRequests: [{
        ...friendRequest,
        action: "accept",
        status: "error",
        error: "Couldn’t accept this request. Try again.",
      }],
      unreads: [],
      unreadDms: [],
      mentions: [],
      marked: [],
      hasProjectedUnreads: false,
      hasProjectedMentions: false,
      onRetryFriendRequest,
    }))
    expect(renderer.getByRole("status").textContent).toContain("Couldn’t accept")
    fireEvent.click(renderer.getByRole("button", { name: "Retry" }))
    expect(onRetryFriendRequest).toHaveBeenCalledTimes(1)
  })

  it("announces row-local pending state and locks only that request", () => {
    const renderer = render(React.createElement(InboxPopover, {
      friendRequests: [{ ...friendRequest, action: "accept", status: "pending" }],
      unreads: [],
      unreadDms: [],
      mentions: [],
      marked: [],
      hasProjectedUnreads: false,
      hasProjectedMentions: false,
    }))
    expect(renderer.getByTestId(tid.inboxFriendRequest("fr_1"))).toHaveAttribute(
      "aria-busy",
      "true",
    )
    expect(renderer.getByTestId(tid.inboxFriendRequestAccept("fr_1"))).toBeDisabled()
    expect(renderer.getByTestId(tid.inboxFriendRequestReject("fr_1"))).toBeDisabled()
  })
})

it("keeps failed marked reads distinct from empty and disables pending retry", () => {
  const onRetryMarked = vi.fn()
  const props = { unreads: [], unreadDms: [], mentions: [], marked: [], markedError: true, onRetryMarked, hasProjectedUnreads: false, hasProjectedMentions: false }
  const renderer = render(React.createElement(InboxPopover, props))
  expect(renderer.queryByText("No marked messages")).toBeNull()
  fireEvent.click(renderer.getByRole("button", { name: "Retry" }))
  expect(onRetryMarked).toHaveBeenCalledOnce()
  renderer.rerender(React.createElement(InboxPopover, { ...props, markedRetrying: true }))
  expect(renderer.getByRole("button", { name: "Retrying…" })).toBeDisabled()
  renderer.rerender(React.createElement(InboxPopover, { ...props, markedError: false }))
  expect(renderer.getByText("No marked messages")).toBeInTheDocument()
})

describe("InboxPopover attention errors", () => {
  it("shows Marked failure and retries without claiming an empty list", () => {
    const onRetryMarked = vi.fn()
    const renderer = render(React.createElement(InboxPopover, {
      unreads: [], unreadDms: [], mentions: [], marked: [], markedError: true, onRetryMarked,
      hasProjectedUnreads: false, hasProjectedMentions: false,
    }))
    const marked = renderer.getByTestId(tid.inboxTabScroll("marked"))
    expect(marked.textContent).not.toContain("No marked messages")
    expect(marked.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load Inbox")
    fireEvent.click(renderer.getByRole("button", { name: "Retry" }))
    expect(onRetryMarked).toHaveBeenCalledOnce()
    renderer.rerender(React.createElement(InboxPopover, {
      unreads: [], unreadDms: [], mentions: [], marked: [], markedError: false,
      hasProjectedUnreads: false, hasProjectedMentions: false,
    }))
    expect(marked.textContent).toContain("No marked messages")
  })

  it("shows Retry instead of Caught up on an initial attention failure", () => {
    const onRetryAttention = vi.fn()
    const renderer = render(React.createElement(InboxPopover, {
      unreads: [],
      unreadDms: [],
      mentions: [],
      marked: [],
      attentionError: true,
      onRetryAttention,
      hasProjectedUnreads: false,
      hasProjectedMentions: false,
    }))
    expect(renderer.queryByText("Caught up")).toBeNull()
    expect(renderer.getAllByRole("alert")).toHaveLength(2)
    expect(renderer.getAllByRole("alert")[0]).toHaveTextContent("Couldn\'t load Inbox")
    expect(renderer.getAllByRole("alert")[1]).toHaveTextContent("Couldn\'t load Inbox")
    fireEvent.click(renderer.getAllByRole("button", { name: "Retry" })[0]!)
    expect(onRetryAttention).toHaveBeenCalledTimes(1)
  })
})

describe("InboxPopover DM rows", () => {
  it("uses the conversation continuation layout in both DM previews", () => {
    mocks.profiles.set("peer", { id: "peer", name: "Mika", discriminator: "0042", avatar: "M" })
    const dm: UnreadDm = {
      channelId: "dm1", otherUserId: "peer", otherUserName: "Mika", otherUserAvatar: "M", otherUserAvatarVersion: 0,
      lastMessageAt: "2026-10-24T00:00:00Z", lastUnreadSeq: 8,
    }
    const mention: Mention = {
      id: "mention-dm", channelId: dm.channelId, server: "", channel: "Mika",
      m: { id: "m7", seq: 7, type: "chat", authorId: "peer", content: "First DM body" },
    }
    const next: Mention = { ...mention, id: "mention-next", m: { ...mention.m, id: "m8", seq: 8, content: "Second DM body" } }
    const saved: Marked = {
      id: "mark-dm", channelId: dm.channelId, serverId: null, server: "", channel: "Mika",
      m: { id: "m9", seq: 9, type: "chat", authorName: "Sender", content: "Saved DM body" },
    }
    const view = renderInboxMessages(React.createElement(InboxPopover, {
      unreads: [], unreadDms: [dm], mentions: [mention, next], marked: [saved],
      hasProjectedUnreads: true, hasProjectedMentions: true,
    }))
    fireEvent.click(view.getByTestId(tid.inboxToggleChannel(dm.channelId)))
    const unread = view.getByTestId(tid.inboxUnreadCard(dm.channelId))
    const marked = view.getByTestId(tid.inboxMarkedCard(saved.id))
    for (const card of [unread, marked]) {
      const avatar = card.querySelector<HTMLElement>('header [data-slot="avatar"]')
      expect(avatar).toHaveStyle({ width: "32px", height: "32px" })
      expect(card.querySelector('[data-slot="inbox-card-divider"]')).toBeNull()
    }
    for (const { row, content, padding } of [
      { row: view.getByTestId(tid.inboxMention(mention.id)), content: "First DM body", padding: "0px 4px" },
      { row: view.getByTestId(tid.inboxMention(next.id)), content: "Second DM body", padding: "4px 8px" },
      { row: marked.querySelector<HTMLElement>('[data-slot="inbox-card-messages"] > div')!, content: "Saved DM body", padding: "0px 8px" },
    ]) {
      const rendered = row.querySelector("[data-message-renderer]")!
      expect(rendered).toHaveTextContent(content)
      expect(rendered).not.toHaveTextContent(/Mika|Sender/)
      expect(rendered.querySelector('[data-slot="avatar"], time')).toBeNull()
      expect(rendered.querySelector(".w-8")).not.toBeNull()
      expect(row.style.paddingBlock).toBe(padding)
    }
  })

  it("keeps author attribution when a marked DM message was sent by someone other than the peer", () => {
    mocks.profiles.set("peer", { id: "peer", name: "Mika", discriminator: "0042", avatar: "M" })
    mocks.profiles.set("viewer", { id: "viewer", name: "Gus", discriminator: "1813", avatar: "G" })
    mocks.dms.push({ id: "dm1", userId: "peer", name: "Mika", discriminator: "0042", avatar: "M" })
    const selfSaved: Marked = {
      id: "mark-self-dm",
      channelId: "dm1",
      serverId: null,
      server: "",
      channel: "Mika",
      m: { id: "m10", seq: 10, type: "chat", authorId: "viewer", authorName: "Gus", content: "My own saved DM" },
    }
    const view = renderInboxMessages(React.createElement(InboxPopover, {
      unreads: [], unreadDms: [], mentions: [], marked: [selfSaved],
      hasProjectedUnreads: false, hasProjectedMentions: false,
    }))
    const card = view.getByTestId(tid.inboxMarkedCard(selfSaved.id))
    const rendered = card.querySelector("[data-message-renderer]")!
    expect(rendered).toHaveTextContent("Gus")
    expect(rendered).toHaveTextContent("My own saved DM")
    expect(rendered.querySelector('[data-slot="avatar"]')).toHaveStyle({ width: "32px", height: "32px" })
  })

  it("opens the same DM from its header and preview text", () => {
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
      renderUnreadMessages: () => React.createElement("span", null, "Current DM preview"),
    }))

    const row = renderer.getByTestId(tid.inboxUnreadDm(dm.channelId))
    expect(row).toHaveAttribute("href", "/c/me/dm-new")
    expect(row).not.toHaveAttribute("data-prefetch")
    fireEvent.pointerEnter(row)
    expect(row).not.toHaveAttribute("data-prefetch")
    expect(onOpenDm).not.toHaveBeenCalled()
    fireEvent.click(row)
    fireEvent.click(renderer.getByTestId(tid.inboxToggleChannel(dm.channelId)))
    fireEvent.click(renderer.getByText("Current DM preview"))
    expect(onOpenDm.mock.calls).toEqual([[dm], [dm]])
  })
})

describe("InboxPopover responsive continuity", () => {
  it("keeps active tab controlled and reports independent scroll offsets", () => {
    const onActiveTabChange = vi.fn()
    const onMarkedTabSelected = vi.fn()
    let unreadsOffset = 73
    const onScrollOffsetChange = vi.fn((tab: string, scrollTop: number) => {
      if (tab === "unreads") unreadsOffset = scrollTop
    })
    const renderer = render(React.createElement(InboxPopover, {
      unreads: [],
      unreadDms: [],
      mentions: [],
      marked: [],
      hasProjectedUnreads: false,
      hasProjectedMentions: false,
      activeTab: "unreads",
      onActiveTabChange,
      onMarkedTabSelected,
      getScrollOffset: (tab) => tab === "unreads" ? unreadsOffset : 0,
      onScrollOffsetChange,
      surface: "mobile",
    }))

    const tabs = mocks.tabs.mock.calls.at(-1)![0] as {
      onValueChange: (value: string) => void
      value: string
    }
    expect(tabs.value).toBe("unreads")
    tabs.onValueChange("marked")
    expect(onActiveTabChange).toHaveBeenCalledWith("marked")
    expect(onMarkedTabSelected).toHaveBeenCalledOnce()

    const unreadsScroll = renderer.getByTestId(tid.inboxTabScroll("unreads"))
    unreadsScroll.scrollTop = 91
    fireEvent.scroll(unreadsScroll)
    expect(onScrollOffsetChange).toHaveBeenCalledWith("unreads", 91)
    onScrollOffsetChange.mockClear()
    unreadsScroll.scrollTop = 42
    fireEvent.scroll(unreadsScroll)
    expect(onScrollOffsetChange).not.toHaveBeenCalled()
    fireEvent.wheel(unreadsScroll)
    fireEvent.scroll(unreadsScroll)
    expect(onScrollOffsetChange).toHaveBeenCalledWith("unreads", 42)
    expect(renderer.getByTestId(tid.inboxTabList)).toBeInTheDocument()
    expect(renderer.container.querySelector("h2")).toBeInTheDocument()
  })

  it("does not reserve extension header space for a shell close button", () => {
    const renderer = render(React.createElement(InboxPopover, {
      unreads: [],
      unreadDms: [],
      mentions: [],
      marked: [],
      hasProjectedUnreads: false,
      hasProjectedMentions: false,
      onMarkAllRead: vi.fn(),
      surface: "extension",
    }))

    expect(renderer.container.querySelector("h2")).toBeInTheDocument()
    expect(renderer.getByRole("button", { name: "Mark all read" })).toBeInTheDocument()
  })
})

describe("InboxPopover Todo tab", () => {
  it("renders pending question cards and submits directly inside Inbox without navigating away", async () => {
    const card = buildDecisionCardEmbed(
      DecisionCardInputSchema.parse({
        summary: "Confirm release timing",
        questions: [{
          id: "timing",
          question: "When should we publish?",
          options: [
            { id: "today", label: "Today", recommended: true },
            { id: "next", label: "Next week" },
          ],
        }],
      }),
      [{ userId: "u_gus", handle: "gus#1813" }],
    )
    const todo: InboxTodo = {
      id: "question:m_q1",
      messageId: "m_q1",
      channelId: "thread_1",
      serverId: "srv_1",
      server: "Alook",
      channel: "gus-issues",
      parentChannelId: null,
      createdAt: "2026-11-21T07:00:00.000Z",
      m: {
        id: "m_q1",
        type: "question",
        seq: 12,
        authorId: "bot_evan",
        authorName: "Evan You",
        createdAt: "2026-11-21T07:00:00.000Z",
        content: "Confirm release timing",
        decisionCard: card,
      },
    }
    const onOpenTodo = vi.fn()
    const onSubmitTodo = vi.fn(async () => ({ replyToId: "m_q1" }))
    const onDismissTodo = vi.fn()

    const renderer = render(React.createElement(InboxPopover, {
      unreads: [],
      unreadDms: [],
      mentions: [],
      todos: [todo],
      marked: [],
      activeTab: "todo",
      viewerUserId: "u_gus",
      hasProjectedUnreads: true,
      hasProjectedMentions: false,
      onOpenTodo,
      onSubmitTodo,
      onDismissTodo,
    }))

    expect(renderer.getByTestId(tid.inboxTabScroll("todo"))).toBeInTheDocument()
    expect(renderer.getByTestId(tid.inboxTodoCard("m_q1"))).toBeInTheDocument()
    expect(renderer.getByLabelText("1 pending question")).toHaveTextContent("1")

    fireEvent.click(renderer.getByText("Today"))
    fireEvent.click(renderer.getByRole("button", { name: "Send answer" }))

    await waitFor(() => {
      expect(onSubmitTodo).toHaveBeenCalledTimes(1)
    })
    expect(onSubmitTodo).toHaveBeenCalledWith(
      todo,
      "Confirm release timing: Today",
      expect.any(String),
    )
    expect(onOpenTodo).not.toHaveBeenCalled()

    fireEvent.click(renderer.getByTestId(tid.inboxTodoDismiss("m_q1")))
    expect(onDismissTodo).toHaveBeenCalledExactlyOnceWith(todo)
    expect(onOpenTodo).not.toHaveBeenCalled()

    fireEvent.click(renderer.getByTestId(tid.inboxTodoOpen("m_q1")))
    expect(onOpenTodo).toHaveBeenCalledExactlyOnceWith(todo)
  })

  it("renders an empty state when there are no pending questions", () => {
    const renderer = render(React.createElement(InboxPopover, {
      unreads: [],
      unreadDms: [],
      mentions: [],
      todos: [],
      marked: [],
      activeTab: "todo",
      hasProjectedUnreads: false,
      hasProjectedMentions: false,
    }))

    expect(renderer.getByText("No pending questions")).toBeInTheDocument()
  })

  it("renders a plus suffix on the Todo badge when pending questions are truncated", () => {
    const todo = {
      id: "question:m_q2",
      messageId: "m_q2",
      channelId: "c1",
      serverId: "s1",
      server: "Alook",
      channel: "general",
      parentChannelId: null,
      createdAt: "2026-09-27T00:00:00.000Z",
      m: {
        id: "m_q2",
        authorId: "u_bot",
        authorName: "Evan",
        authorAvatar: null,
        authorAvatarVersion: 0,
        content: "Ship now?",
        type: "question" as const,
        createdAt: "2026-09-27T00:00:00.000Z",
        seq: 5,
        decisionCard: {
          kind: "decision_card" as const,
          version: 1 as const,
          summary: "Ship now?",
          assignees: [{ userId: "u_gus", handle: "gus#1813" }],
          questions: [{
            id: "q1",
            question: "Ship now?",
            multiSelect: false,
            allowOther: false,
            options: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ],
          }],
        },
      },
    }
    const renderer = render(React.createElement(InboxPopover, {
      unreads: [],
      unreadDms: [],
      mentions: [],
      todos: [todo],
      todosTruncated: true,
      marked: [],
      activeTab: "todo",
      hasProjectedUnreads: false,
      hasProjectedMentions: false,
    }))

    expect(renderer.getByLabelText("1+ pending questions")).toHaveTextContent("1+")
  })

  it("submits free-text Todo reply via persistent inline bar, validates replyToId, and preserves ChannelIcon aspect ratio", async () => {
    const card = buildDecisionCardEmbed(
      DecisionCardInputSchema.parse({
        summary: "Confirm release timing",
        questions: [{
          id: "timing",
          question: "When should we publish?",
          options: [
            { id: "today", label: "Today", recommended: true },
            { id: "next", label: "Next week" },
          ],
        }],
      }),
      [{ userId: "u_gus", handle: "gus#1813" }],
    )
    const todo: InboxTodo = {
      id: "question:m_q3",
      messageId: "m_q3",
      channelId: "ch_uiux",
      serverId: "srv_1",
      server: "Alook",
      channel: "gus-uiux",
      parentChannelId: null,
      createdAt: "2026-11-23T03:50:00.000Z",
      m: {
        id: "m_q3",
        type: "question",
        seq: 20,
        authorId: "bot_evan",
        authorName: "Evan You",
        createdAt: "2026-11-23T03:50:00.000Z",
        content: "Confirm release timing",
        decisionCard: card,
      },
    }
    const onOpenTodo = vi.fn()
    const onReplyTodo = vi.fn()
      .mockResolvedValueOnce({ replyToId: null })
      .mockResolvedValueOnce({ replyToId: "m_q3" })

    const renderer = render(React.createElement(InboxPopover, {
      unreads: [],
      unreadDms: [],
      mentions: [],
      todos: [todo],
      marked: [],
      activeTab: "todo",
      viewerUserId: "u_gus",
      hasProjectedUnreads: true,
      hasProjectedMentions: false,
      onOpenTodo,
      onReplyTodo,
    }))

    const headerButton = renderer.getByTestId(tid.inboxTodoOpen("m_q3"))
    const channelIcon = headerButton.querySelector("svg[viewBox='7 0 14 24']")
    expect(channelIcon).not.toBeNull()

    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(hover: hover) and (pointer: fine)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    try {
      renderer.rerender(React.createElement(InboxPopover, {
        unreads: [],
        unreadDms: [],
        mentions: [],
        todos: [todo],
        marked: [],
        activeTab: "todo",
        viewerUserId: "u_gus",
        hasProjectedUnreads: true,
        hasProjectedMentions: false,
        onOpenTodo,
        onReplyTodo,
      }))
      const input = renderer.getByTestId(tid.inboxTodoReplyInput("m_q3")) as HTMLTextAreaElement
      const send = renderer.getByTestId(tid.inboxTodoReplySend("m_q3")) as HTMLButtonElement
      expect(send).toBeDisabled()

      fireEvent.change(input, { target: { value: "Hold until afternoon" } })
      expect(send).toBeEnabled()
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
      expect(onReplyTodo).not.toHaveBeenCalled()

      fireEvent.click(send)
      await waitFor(() => {
        expect(renderer.getByRole("alert")).toHaveTextContent("Could not link your reply")
      })
      expect(input.value).toBe("Hold until afternoon")
      expect(onOpenTodo).not.toHaveBeenCalled()

      fireEvent.click(send)
      await waitFor(() => {
        expect(onReplyTodo).toHaveBeenCalledTimes(2)
        expect(input.value).toBe("")
      })
      expect(onReplyTodo).toHaveBeenLastCalledWith(todo, "Hold until afternoon", expect.any(String))
      expect(onOpenTodo).not.toHaveBeenCalled()
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })
})

describe("InboxPopover inline reply in Unreads", () => {
  it("renders inline reply in expanded DM, text channel, and thread cards, omits it on forum containers, and preserves draft + nonce on failure", async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(hover: hover) and (pointer: fine)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    try {
      const onOpenChannel = vi.fn()
      const onOpenDm = vi.fn()
      const onReplyChannel = vi.fn()
        .mockRejectedValueOnce(new Error("Temporary outage"))
        .mockResolvedValueOnce({ id: "m_sent", seq: 9 })

      const renderer = render(React.createElement(InboxPopover, {
        unreads: [{
          serverId: "s1",
          serverName: "Alook",
          channels: [
            {
              channelId: "ch_text",
              channelName: "general",
              type: "text",
              lastMessageAt: "2026-11-23T03:00:00.000Z",
              lastUnreadSeq: 8,
              unreadCount: 1,
              mentionCount: 0,
              hasDirectUnread: true,
              children: [{
                channelId: "ch_thread",
                channelName: "release-notes",
                type: "thread",
                lastMessageAt: "2026-11-23T03:01:00.000Z",
                lastUnreadSeq: 3,
                unreadCount: 1,
                mentionCount: 0,
              }],
            },
            {
              channelId: "ch_forum",
              channelName: "gus-issues",
              type: "forum",
              lastMessageAt: "2026-11-23T03:02:00.000Z",
              lastUnreadSeq: 5,
              unreadCount: 1,
              mentionCount: 0,
              hasDirectUnread: true,
              children: [],
            },
          ],
        }],
        unreadDms: [{
          channelId: "dm_1",
          otherUserId: "u_alli",
          otherUserName: "Alli",
          otherUserDiscriminator: "6011",
          otherUserAvatar: "A",
          otherUserAvatarVersion: 0,
          lastMessageAt: "2026-11-23T03:03:00.000Z",
          lastUnreadSeq: 4,
          unreadCount: 1,
        }],
        mentions: [],
        marked: [],
        hasProjectedUnreads: true,
        hasProjectedMentions: false,
        onOpenChannel,
        onOpenDm,
        onReplyChannel,
      }))

      fireEvent.click(renderer.getByTestId(tid.inboxToggleChannel("ch_forum")))
      expect(renderer.queryByTestId(tid.inboxReplyInput("ch_forum"))).toBeNull()

      fireEvent.click(renderer.getByTestId(tid.inboxToggleChannel("ch_thread")))
      expect(renderer.getByTestId(tid.inboxReplyInput("ch_thread"))).toBeInTheDocument()

      fireEvent.click(renderer.getByTestId(tid.inboxToggleChannel("dm_1")))
      expect(renderer.getByTestId(tid.inboxReplyInput("dm_1"))).toBeInTheDocument()

      fireEvent.click(renderer.getByTestId(tid.inboxToggleChannel("ch_text")))
      const input = renderer.getByTestId(tid.inboxReplyInput("ch_text")) as HTMLInputElement
      expect(input.tagName).toBe("INPUT")
      expect(input.type).toBe("text")
      expect(input.getAttribute("enterkeyhint")).toBe("send")
      const sendButton = renderer.getByTestId(tid.inboxReplySend("ch_text")) as HTMLButtonElement
      expect(sendButton).toHaveClass("community-composer-send")
      expect(sendButton.getAttribute("data-variant")).toBe("default")
      expect(sendButton).toBeDisabled()
      fireEvent.click(input)
      expect(onOpenChannel).not.toHaveBeenCalled()
      expect(onOpenDm).not.toHaveBeenCalled()

      fireEvent.change(input, { target: { value: "Looks good" } })
      expect(sendButton).toBeEnabled()
      fireEvent.keyDown(input, { key: "Enter", isComposing: true })
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
      expect(onReplyChannel).not.toHaveBeenCalled()
      fireEvent.keyDown(input, { key: "Enter" })
      await waitFor(() => {
        expect(renderer.getByRole("alert")).toHaveTextContent("Temporary outage")
      })
      expect(input.value).toBe("Looks good")
      const firstNonce = onReplyChannel.mock.calls[0]?.[2]
      expect(firstNonce).toEqual(expect.any(String))

      fireEvent.click(sendButton)
      await waitFor(() => {
        expect(onReplyChannel).toHaveBeenCalledTimes(2)
        expect(input.value).toBe("")
      })
      expect(onReplyChannel.mock.calls[1]).toEqual(["ch_text", "Looks good", firstNonce])
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it("allows submitting unread Decision Cards directly inside Unreads without navigating away", async () => {
    const card = buildDecisionCardEmbed(
      DecisionCardInputSchema.parse({
        summary: "Merge PR #1405?",
        questions: [{
          id: "merge",
          question: "Merge now?",
          options: [
            { id: "yes", label: "Merge", recommended: true },
            { id: "wait", label: "Wait" },
          ],
        }],
      }),
      [{ userId: "u_gus", handle: "gus#1813" }],
    )
    const onOpenChannel = vi.fn()
    const onSubmitDecisionCard = vi.fn(async () => ({ replyToId: "m_dc_1" }))

    const renderer = renderInboxMessages(React.createElement(InboxPopover, {
      unreads: [{
        serverId: "s1",
        serverName: "Alook",
        channels: [{
          channelId: "ch_1",
          channelName: "gus-uiux",
          type: "text",
          lastMessageAt: "2026-11-23T03:00:00.000Z",
          lastUnreadSeq: 2,
          unreadCount: 1,
          mentionCount: 1,
          hasDirectUnread: true,
          children: [],
        }],
      }],
      unreadDms: [],
      mentions: [{
        id: "mention_dc",
        server: "Alook",
        serverId: "s1",
        channel: "gus-uiux",
        channelId: "ch_1",
        m: {
          id: "m_dc_1",
          type: "question",
          seq: 2,
          authorId: "bot_evan",
          authorName: "Evan You",
          createdAt: "2026-11-23T03:00:00.000Z",
          content: "Merge PR #1405?",
          decisionCard: card,
        },
      }],
      marked: [],
      viewerUserId: "u_gus",
      hasProjectedUnreads: true,
      hasProjectedMentions: true,
      onOpenChannel,
      onSubmitDecisionCard,
    }))

    fireEvent.click(renderer.getByTestId(tid.inboxToggleChannel("ch_1")))
    fireEvent.click(renderer.getByText("Merge"))
    fireEvent.click(renderer.getByRole("button", { name: "Send answer" }))

    await waitFor(() => {
      expect(onSubmitDecisionCard).toHaveBeenCalledTimes(1)
    })
    expect(onSubmitDecisionCard).toHaveBeenCalledWith("ch_1", "m_dc_1", "Merge PR #1405?: Merge", expect.any(String))
    expect(onOpenChannel).not.toHaveBeenCalled()
  })

  it("formats ApiError (429, 403 blocked, generic) and non-Error failures and resets nonce after editing", async () => {
    const onReplyChannel = vi.fn()
      .mockRejectedValueOnce(new ApiError("Too many requests", 429))
      .mockRejectedValueOnce(new ApiError("User is blocked", 403))
      .mockRejectedValueOnce(new ApiError("Server overloaded", 500))
      .mockRejectedValueOnce("unexpected")
      .mockResolvedValueOnce({ id: "m_ok", seq: 5 })

    const renderer = render(React.createElement(InboxPopover, {
      unreads: [],
      unreadDms: [{
        channelId: "dm_err",
        otherUserId: "u_peer",
        otherUserName: "Peer",
        otherUserDiscriminator: "0001",
        otherUserAvatar: "P",
        otherUserAvatarVersion: 0,
        lastMessageAt: "2026-11-23T03:00:00.000Z",
        lastUnreadSeq: 2,
        unreadCount: 1,
      }],
      mentions: [],
      marked: [],
      hasProjectedUnreads: true,
      hasProjectedMentions: false,
      onReplyChannel,
    }))

    fireEvent.click(renderer.getByTestId(tid.inboxToggleChannel("dm_err")))
    const input = renderer.getByTestId(tid.inboxReplyInput("dm_err")) as HTMLInputElement
    const send = renderer.getByTestId(tid.inboxReplySend("dm_err")) as HTMLButtonElement

    fireEvent.change(input, { target: { value: "First draft" } })
    fireEvent.click(send)
    await waitFor(() => {
      expect(renderer.getByRole("alert")).toHaveTextContent("Rate limited — wait a moment and try again.")
    })
    const firstNonce = onReplyChannel.mock.calls[0]?.[2]

    fireEvent.click(send)
    await waitFor(() => {
      expect(renderer.getByRole("alert")).toHaveTextContent("User is blocked")
    })
    expect(onReplyChannel.mock.calls[1]?.[2]).toBe(firstNonce)

    fireEvent.change(input, { target: { value: "Edited draft" } })
    expect(renderer.queryByRole("alert")).toBeNull()
    fireEvent.click(send)
    await waitFor(() => {
      expect(renderer.getByRole("alert")).toHaveTextContent("Server overloaded")
    })
    const secondNonce = onReplyChannel.mock.calls[2]?.[2]
    expect(secondNonce).not.toBe(firstNonce)

    fireEvent.click(send)
    await waitFor(() => {
      expect(renderer.getByRole("alert")).toHaveTextContent("Could not send reply — try again.")
    })

    fireEvent.click(send)
    await waitFor(() => {
      expect(input.value).toBe("")
    })
  })

  it("keeps a focused inline reply input scrolled into view instead of resetting scrollTop on resize", async () => {
    const callbacks: ResizeObserverCallback[] = []
    const originalResizeObserver = window.ResizeObserver
    class MockResizeObserver {
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        callbacks.push(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    try {
      const getScrollOffset = vi.fn(() => 0)
      const renderer = render(React.createElement(InboxPopover, {
        unreads: [],
        unreadDms: [{
          channelId: "dm_kb",
          otherUserId: "u_peer",
          otherUserName: "Peer",
          otherUserDiscriminator: "0001",
          otherUserAvatar: "P",
          otherUserAvatarVersion: 0,
          lastMessageAt: "2026-11-23T03:00:00.000Z",
          lastUnreadSeq: 2,
          unreadCount: 1,
        }],
        mentions: [],
        marked: [],
        hasProjectedUnreads: true,
        hasProjectedMentions: false,
        getScrollOffset,
        onReplyChannel: vi.fn().mockResolvedValue({ id: "m_ok", seq: 3 }),
      }))

      fireEvent.click(renderer.getByTestId(tid.inboxToggleChannel("dm_kb")))
      const scrollViewport = renderer.getByTestId(tid.inboxTabScroll("unreads"))
      const input = renderer.getByTestId(tid.inboxReplyInput("dm_kb")) as HTMLInputElement
      const scrollIntoView = vi.fn()
      input.scrollIntoView = scrollIntoView

      scrollViewport.scrollTop = 140
      input.focus()
      expect(document.activeElement).toBe(input)

      await act(async () => {
        for (const cb of callbacks) cb([], {} as ResizeObserver)
      })

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
      expect(scrollViewport.scrollTop).toBe(140)
    } finally {
      window.ResizeObserver = originalResizeObserver
    }
  })
})
