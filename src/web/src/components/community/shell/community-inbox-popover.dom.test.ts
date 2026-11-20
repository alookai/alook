import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { InboxPopover } from "./community-inbox-popover"
import type { Marked, Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import { tid } from "@/lib/community/testids"
import type { CommunityProfile } from "@/lib/community/models/people"

vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))

const mocks = vi.hoisted(() => ({
  tabs: vi.fn(),
  profiles: new Map<string, CommunityProfile>(),
  categories: new Map<string, { name: string }>(),
  channels: new Map<string, { name: string; type: "forum"; categoryId: string }>(),
}))

vi.mock("@/lib/community-db/projections", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useCanonicalProfilesByUserId: () => mocks.profiles,
  useCanonicalCommunityProfile: (id: string | undefined) => id ? mocks.profiles.get(id) : undefined,
  useCanonicalCategoriesById: () => mocks.categories,
  useCanonicalChannelsById: () => mocks.channels,
}))

beforeEach(() => {
  mocks.profiles.clear()
  mocks.categories.clear()
  mocks.channels.clear()
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
    const view = render(React.createElement(InboxPopover, {
      unreads: unreadFixture(), unreadDms: [], mentions: [], marked: [], hasProjectedUnreads: true, hasProjectedMentions: false,
      renderUnreadMessages, onMarkChannelRead, onOpenThread,
    }))
    expect(renderUnreadMessages).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole("button", { name: "Show unread messages in Reply-only thread" }))
    expect(view.getByText("unread t1")).toBeDefined()
    expect(view.queryByText("unread p1")).toBeNull()
    fireEvent.click(view.getByRole("button", { name: "Hide unread messages in Reply-only thread" }))
    expect(view.queryByText("unread t1")).toBeNull()
    expect(onMarkChannelRead).not.toHaveBeenCalled()
    expect(onOpenThread).not.toHaveBeenCalled()
  })

  it("retries the selected channel's captured watermark without reading a later arrival", async () => {
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.children[0]!.lastUnreadSeq = 23
    const onMarkChannelRead = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined)
    const onOpenThread = vi.fn()
    const props = { unreads, unreadDms: [], mentions: [], marked: [], hasProjectedUnreads: true, hasProjectedMentions: false, onMarkChannelRead, onOpenThread }
    const view = render(React.createElement(InboxPopover, props))
    fireEvent.click(view.getByRole("button", { name: "Mark Full authoritative opener content read" }))
    await waitFor(() => expect(onMarkChannelRead).toHaveBeenCalledExactlyOnceWith("p1", 23))
    await waitFor(() => expect(view.getByRole("button", { name: "Retry marking Full authoritative opener content read" })).toBeDefined())
    const newer = structuredClone(unreads)
    newer[0]!.channels[0]!.children[0]!.lastUnreadSeq = 24
    view.rerender(React.createElement(InboxPopover, { ...props, unreads: newer }))
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
  it.each([undefined, 0, 3])("shows a known positive DM unread count: %s", (unreadCount) => {
    mocks.profiles.set("peer", { id: "peer", name: "Mika", discriminator: "0042" })
    const dm: UnreadDm = { channelId: "dm1", otherUserId: "peer", otherUserName: "Mika", otherUserDiscriminator: "0042", otherUserAvatar: "M", otherUserAvatarVersion: 0, lastMessageAt: "2026-10-24T00:00:00Z", unreadCount }
    const onOpenDm = vi.fn()
    const renderer = render(React.createElement(InboxPopover, {
      unreads: [], unreadDms: [dm], mentions: [], marked: [], hasProjectedUnreads: true, hasProjectedMentions: false, onOpenDm,
    }))
    const row = renderer.getByTestId(tid.inboxUnreadDm("dm1"))
    expect(row.textContent).toBe(unreadCount ? "Mika#0042Direct Messages3" : "Mika#0042Direct Messages")
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
    expect(check).toHaveAttribute("data-variant", "ghost")
    expect(arrow).toHaveAttribute("data-variant", "ghost")
    expect(check).toHaveAttribute("data-size", "icon")
    expect(arrow).toHaveAttribute("data-size", "icon")
    expect(check).toHaveClass("bg-accent")
    expect(arrow).not.toHaveClass("bg-accent")
    expect(check.querySelector("svg")).toHaveClass("size-4")
    expect(arrow.querySelector("svg")).toHaveClass("size-4")
    expect(check.querySelector('[data-slot="inbox-action-visual"]')).toHaveClass("max-sm:size-7", "max-sm:group-enabled/button:bg-accent")
    expect(arrow.querySelector('[data-slot="inbox-action-visual"]')).toHaveClass("max-sm:size-7")
    expect(check.nextElementSibling).toBe(arrow)
    expect(icon.closest("header")).toBe(arrow.closest("header"))
    expect(icon.nextElementSibling?.matches("svg")).toBe(false)
    const identity = renderer.getByTestId(tid.inboxUnreadChannel("f1"))
    expect(identity.querySelector("span.size-5 > svg.size-4")).not.toBeNull()
    for (const tab of ["unreads", "marked"] as const) {
      const scroller = renderer.getByTestId(tid.inboxTabScroll(tab))
      expect(scroller).toHaveClass("scroll-fade-b", "scroll-fade-4")
      expect(scroller).not.toHaveClass("p-3")
      expect(scroller.firstElementChild).toHaveClass("p-3")
    }
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

  it("opens an exact unread forum opener from the parent card preview", () => {
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
    const openThread = vi.fn()
    const markChannelRead = vi.fn()
    const view = render(React.createElement(InboxPopover, {
      unreads, unreadDms: [], mentions: [], marked: [],
      hasProjectedUnreads: true, hasProjectedMentions: false,
      onOpenThread: openThread, onMarkChannelRead: markChannelRead,
      renderUnreadMessages: ({ openForumPosts }) => React.createElement(
        "button", { onClick: openForumPosts?.get("opener-1") }, "First post",
      ),
    }))
    fireEvent.click(view.getByTestId(tid.inboxToggleChannel(parent.channelId)))
    expect(openThread).not.toHaveBeenCalled()
    expect(markChannelRead).not.toHaveBeenCalled()
    expect(view.queryByTestId(tid.inboxUnreadChild(firstOpener.channelId))).toBeNull()
    fireEvent.click(view.getByRole("button", { name: "First post" }))
    expect(openThread).toHaveBeenCalledExactlyOnceWith(server, parent, firstOpener)
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
    expect(parentRows[0]!.querySelector('[aria-label="3 unread messages"]')).toHaveTextContent("3")
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
    expect(parentRows[0]!.querySelector('[aria-label="3 unread messages"]')).toHaveTextContent("3")
    expect(openerRows[0]!.querySelector('[aria-label="5 unread messages"]')).toHaveTextContent("5")
    expect(renderer.getByTestId(tid.inboxUnreadChild("t1")).querySelector('[aria-label="1 unread message"]')).toHaveTextContent("1")
    fireEvent.click(parentRows[0]!)
    expect(onOpenChannel).toHaveBeenCalledWith(
      unreads[0],
      unreads[0]!.channels[0],
      true,
    )
  })
})

describe("InboxPopover channel mentions", () => {
  it("keeps mentions in their channel card and preserves exact-message navigation", () => {
    mocks.profiles.set("author", { id: "author", name: "Alice", discriminator: "0042", avatar: "A" })
    const onOpenMention = vi.fn()
    const onMarkChannelRead = vi.fn()
    const mention: Mention = { id: "mention-1", server: "Server", channel: "Forum", channelId: "f1", serverId: "s1", m: { id: "message-1", seq: 7, type: "chat", authorId: "author", content: "Hello there" } }
    const unreads = unreadFixture()
    unreads[0]!.channels[0]!.lastUnreadSeq = 7
    const renderer = renderInboxMessages(React.createElement(InboxPopover, {
      unreads, unreadDms: [], mentions: [mention], marked: [],
      hasProjectedUnreads: true, hasProjectedMentions: true, onOpenMention, onMarkChannelRead,
    }))
    expect(renderer.queryByText("Hello there")).toBeNull()
    fireEvent.click(renderer.getByRole("button", { name: "Show unread messages in Forum" }))
    expect(renderer.getByText("Alice")).toBeDefined()
    expect(renderer.getByTestId(tid.inboxUnreadMessages("f1"))).toBeDefined()
    const preview = renderer.getByTestId(tid.inboxMention(mention.id))
    expect(preview.querySelector("[data-message-renderer]")).not.toBeNull()
    fireEvent.click(preview)
    expect(onOpenMention).toHaveBeenCalledExactlyOnceWith(mention)
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
    expect(text.indexOf("Friend requests — 1")).toBeLessThan(text.indexOf("Direct Messages"))
    expect(text.indexOf("Direct Messages")).toBeLessThan(text.indexOf("Server"))

    const open = renderer.getByTestId(tid.inboxFriendRequestOpen("fr_1"))
    expect(open.textContent).toBe("Ada#0001")
    expect(open.querySelector(".text-xs")?.textContent).toBe("#0001")
    const accept = renderer.getByTestId(tid.inboxFriendRequestAccept("fr_1"))
    const reject = renderer.getByTestId(tid.inboxFriendRequestReject("fr_1"))
    for (const action of [accept, reject]) {
      expect(action).toHaveClass("size-11", "sm:size-8")
      expect(action.querySelector('[data-slot="inbox-action-visual"]')).toHaveClass("max-sm:size-7")
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
    expect(renderer.getAllByRole("alert")).toHaveLength(1)
    expect(renderer.getAllByRole("alert")[0]).toHaveTextContent("Couldn\'t load Inbox")
    fireEvent.click(renderer.getAllByRole("button", { name: "Retry" })[0]!)
    expect(onRetryAttention).toHaveBeenCalledTimes(1)
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

    const row = renderer.getByTestId(tid.inboxUnreadDm(dm.channelId))
    expect(row).toHaveAttribute("href", "/c/me/dm-new")
    expect(row).not.toHaveAttribute("data-prefetch")
    fireEvent.pointerEnter(row)
    expect(row).not.toHaveAttribute("data-prefetch")
    expect(onOpenDm).not.toHaveBeenCalled()
    fireEvent.click(row)

    expect(onOpenDm).toHaveBeenCalledWith(dm)
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
      className: string
      onValueChange: (value: string) => void
      value: string
    }
    expect(tabs.value).toBe("unreads")
    expect(tabs.className).toContain("h-full")
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
    const header = renderer.container.querySelector("h2")?.parentElement
    expect(header).toHaveClass("flex", "items-center", "gap-2", "px-3", "pt-4")
    expect(header).not.toHaveClass("pr-15", "sm:pr-12")
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

    const header = renderer.container.querySelector("h2")?.parentElement
    expect(header).toHaveClass("flex", "items-center", "gap-2", "px-3", "pt-4")
    expect(header).not.toHaveClass("pr-15", "sm:pr-12")
    expect(renderer.getByRole("button", { name: "Mark all read" })).toBeInTheDocument()
  })
})
