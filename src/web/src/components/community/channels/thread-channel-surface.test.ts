import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadChannelSurface } from "./thread-channel-surface"
import { ChannelHeader, ChannelHeaderSkeleton } from "./channel-header"
import { CommunityPanel } from "../shell/community-panel"
import { Composer } from "../messages/composer"
import { MessageContextSheet } from "../messages/message-context-sheet"
import { MessageList } from "../messages/message-list"
import { ThreadOpener } from "../messages/thread-opener"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import { useClaimThreadOpenerReadHandoff } from "@/hooks/community/thread-opener-read-handoff"
import type { MessageChannelControllerValue } from "../messages/message-channel-controller"

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  apiFetch: vi.fn(),
  toastApiError: vi.fn(),
  editMessage: vi.fn(),
  acceptMessage: vi.fn(() => true),
  handleTyping: vi.fn(),
  setReplyTo: vi.fn(),
  jumpToSeq: vi.fn(),
  search: vi.fn(),
  setContextTarget: vi.fn(),
}))

vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }))
vi.mock("@/lib/api/client", () => ({
  apiFetch: mocks.apiFetch,
  toastApiError: mocks.toastApiError,
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/hooks/community/thread-opener-read-handoff", () => ({
  useClaimThreadOpenerReadHandoff: vi.fn(),
}))
vi.mock("@/hooks/community/use-channel-message-feed", () => ({
  useChannelMessageFeed: vi.fn(),
}))
vi.mock("@/hooks/community/mutations", () => ({
  useEditMessage: () => ({ mutateAsync: mocks.editMessage }),
}))
vi.mock("@/components/community/channels/channel-header", () => ({
  ChannelHeader: vi.fn(() => null),
  ChannelHeaderSkeleton: vi.fn(() => null),
}))
vi.mock("@/components/community/channels/channel-shell", () => ({
  ChannelShell: ({
    header,
    body,
    panels,
    dialogs,
  }: {
    header: React.ReactNode
    body: React.ReactNode
    panels?: React.ReactNode
    dialogs?: React.ReactNode
  }) => React.createElement(React.Fragment, null, header, body, panels, dialogs),
}))
vi.mock("@/components/community/shell/community-panel", () => ({
  CommunityPanel: vi.fn(() => null),
}))
vi.mock("@/components/community/messages/composer", () => ({
  Composer: vi.fn(() => null),
  ComposerSkeleton: vi.fn(() => null),
}))
vi.mock("@/components/community/messages/message-context-sheet", () => ({
  MessageContextSheet: vi.fn(() => null),
}))
vi.mock("@/components/community/messages/message-list", () => ({
  MessageList: vi.fn(() => null),
}))
vi.mock("@/components/community/messages/thread-opener", () => ({
  ThreadOpener: vi.fn(() => null),
}))
vi.mock("@/components/community/messages/message-channel-controller", () => ({
  MessageChannelController: ({
    feed: messageFeed,
    children,
  }: {
    feed: ReturnType<typeof useChannelMessageFeed>
    children: (controller: MessageChannelControllerValue) => React.ReactNode
  }) => children({
    feed: messageFeed,
    pinnedIds: new Set(["pinned_1"]),
    replyTo: { id: "reply_1", authorName: "Alice", text: "hello" },
    setReplyTo: mocks.setReplyTo,
    searchQuery: "query",
    searchResults: [{ id: "search_1", type: "chat" }],
    search: mocks.search,
    scrollTargetId: "m_target",
    setScrollTargetId: vi.fn(),
    consumeScrollTarget: vi.fn(),
    contextTarget: { serverId: "server_1", channelId: "source_1", label: "source", seq: 4 },
    setContextTarget: mocks.setContextTarget,
    openContextSeq: vi.fn(),
    onSheetReply: vi.fn(),
    jumpToSeq: mocks.jumpToSeq,
    messageActions: {
      onToggleReaction: vi.fn(),
      onReact: vi.fn(),
      onReply: vi.fn(),
      onPin: vi.fn(),
      onMark: vi.fn(),
      onCreateThread: vi.fn(),
      onCopy: vi.fn(),
      onEdit: vi.fn(),
      onRetry: vi.fn(),
      onPreviewImage: vi.fn(),
      onDownloadFile: vi.fn(),
    },
    threadActions: {
      onToggleReaction: vi.fn(),
      onReact: vi.fn(),
      onReply: vi.fn(),
      onPin: vi.fn(),
      onMark: vi.fn(),
      onCreateThread: undefined,
      onCopy: vi.fn(),
      onEdit: vi.fn(),
      onRetry: vi.fn(),
      onPreviewImage: vi.fn(),
      onDownloadFile: vi.fn(),
    },
    acceptMessage: mocks.acceptMessage,
    handleTyping: mocks.handleTyping,
    typingUsers: ["Alice"],
  }),
}))

const mockedChannelHeader = vi.mocked(ChannelHeader)
const mockedChannelHeaderSkeleton = vi.mocked(ChannelHeaderSkeleton)
const mockedCommunityPanel = vi.mocked(CommunityPanel)
const mockedComposer = vi.mocked(Composer)
const mockedMessageContextSheet = vi.mocked(MessageContextSheet)
const mockedMessageList = vi.mocked(MessageList)
const mockedUseChannelMessageFeed = vi.mocked(useChannelMessageFeed)
const mockedUseClaimThreadOpenerReadHandoff = vi.mocked(useClaimThreadOpenerReadHandoff)

function feed(overrides: Record<string, unknown> = {}) {
  return {
    messages: [{ id: "message_1", type: "chat" }],
    isLoading: false,
    isError: false,
    isFetchingOlder: false,
    isFetchingNewer: false,
    hasMoreOlder: false,
    hasMoreNewer: false,
    fetchOlder: vi.fn(),
    fetchNewer: vi.fn(),
    jumpToPresent: vi.fn(),
    readSnapshotFetching: false,
    anchorInCache: true,
    newDividerBefore: undefined,
    unreadCount: 0,
    setScrollRootEl: vi.fn(),
    threads: [{ id: "child_2" }],
    threadsLoading: false,
    pinned: [{ id: "pinned_1", type: "chat" }],
    pinnedLoading: false,
    ...overrides,
  } as ReturnType<typeof useChannelMessageFeed>
}

function surfaceProps(overrides: Record<string, unknown> = {}) {
  return {
    channelId: "thread_1",
    serverId: "server_1",
    serverParam: "server_1",
    channelName: "Thread name",
    viewer: { id: "viewer_1", name: "Viewer", discriminator: "1111", avatar: "V" },
    anchorMessageId: "m_target",
    parentChannelId: "parent_1",
    parentMessageId: "opener_1",
    parentChannelName: "general",
    parentIsForum: false,
    childCreatorId: "viewer_1",
    canRenameThread: true,
    notificationLevel: "default" as const,
    onSetNotificationLevel: vi.fn(),
    onBack: vi.fn(),
    composerMembers: [{
      id: "member_1",
      userId: "member_1",
      name: "Alice",
      discriminator: "0042",
      avatar: "A",
      status: "online",
      sub: "",
      role: "member",
    }],
    composerMentionCandidates: undefined,
    channelRefCandidates: [{ id: "parent_1", name: "general", serverId: "server_1", serverName: "Server", serverDiscriminator: "0001" }],
    memberPanelProps: {
      members: [],
      membersLoading: false,
      membersLoadingMore: false,
      membersHasMore: false,
    },
    manageMembersDialog: React.createElement("span", { "data-manage-dialog": true }),
    uiHandlers: { previewImage: vi.fn() },
    onOpenChild: vi.fn(),
    onOpenProfile: vi.fn(),
    resolveUserName: (userId: string) => userId,
    ...overrides,
  }
}

function renderSurface(overrides: Record<string, unknown> = {}) {
  return React.createElement(ThreadChannelSurface, surfaceProps(overrides))
}

describe("ThreadChannelSurface ownership", () => {
  beforeEach(() => {
    mockedUseClaimThreadOpenerReadHandoff.mockReset()
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    mocks.apiFetch.mockResolvedValue({})
    mocks.editMessage.mockResolvedValue({})
  })

  it("installs the parent-opener claim hook before initializing the child feed", () => {
    const order: string[] = []
    const handoff = { nonce: "nonce-1" } as never
    mockedUseClaimThreadOpenerReadHandoff.mockImplementation(() => { order.push("claim") })
    mockedUseChannelMessageFeed.mockImplementation(() => {
      order.push("feed")
      return feed()
    })

    act(() => {
      TestRenderer.create(renderSurface({ threadOpenerHandoff: handoff, parentIsForum: true }))
    })

    expect(order.slice(0, 2)).toEqual(["claim", "feed"])
    expect(mockedUseClaimThreadOpenerReadHandoff).toHaveBeenCalledWith(handoff)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("owns the child feed and preserves opener, message-list, and composer wiring", () => {
    const props = surfaceProps()

    act(() => {
      TestRenderer.create(React.createElement(ThreadChannelSurface, props))
    })

    expect(mockedUseChannelMessageFeed).toHaveBeenCalledTimes(1)
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith({
      channelId: "thread_1",
      serverId: "server_1",
      viewerUserId: "viewer_1",
      isChildChannel: true,
      anchorMessageId: "m_target",
    })
    const messageListProps = mockedMessageList.mock.calls.at(-1)![0]
    const opener = messageListProps.hero as React.ReactElement<React.ComponentProps<typeof ThreadOpener>>
    expect(opener.type).toBe(ThreadOpener)
    expect(opener.props).toEqual(expect.objectContaining({
      parentMessageId: "opener_1",
      viewerUserId: "viewer_1",
      onOpenProfile: props.onOpenProfile,
      resolveAuthorMentionText: expect.any(Function),
      onInsertMentionText: expect.any(Function),
    }))
    act(() => opener.props.onJump?.())
    expect(mocks.router.push).toHaveBeenCalledWith("/c/channels/server_1/parent_1?msg=opener_1")
    act(() => opener.props.onPreviewImage?.("https://example.test/image.png"))
    expect(props.uiHandlers.previewImage).toHaveBeenCalledWith("https://example.test/image.png")
    const anchor = { href: "", download: "", click: vi.fn() }
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) })
    act(() => opener.props.onDownloadFile?.("https://example.test/report.pdf", "report.pdf"))
    expect(anchor).toEqual(expect.objectContaining({
      href: "https://example.test/report.pdf",
      download: "report.pdf",
    }))
    expect(anchor.click).toHaveBeenCalledTimes(1)

    expect(mockedMessageList).toHaveBeenCalledWith(expect.objectContaining({
      channel: "Thread name",
      messages: expect.arrayContaining([expect.objectContaining({ id: "message_1" })]),
      scrollToMessageId: "m_target",
      initialScrollReady: true,
      onCreateThread: undefined,
      hero: expect.anything(),
    }), undefined)
    expect(messageListProps.resolveAuthorMentionText?.("member_1")).toBe("@Alice#0042")
    expect(messageListProps.resolveAuthorMentionText?.("viewer_1")).toBe("@Viewer#1111")
    expect(messageListProps.onInsertMentionText).toEqual(expect.any(Function))
    const composerProps = mockedComposer.mock.calls.at(-1)![0]
    expect(composerProps).toEqual(expect.objectContaining({
      channel: "Thread name",
      context: "thread",
      members: props.composerMembers,
      mentionCandidates: props.composerMentionCandidates,
      channelRefCandidates: props.channelRefCandidates,
      replyingTo: "Alice",
      autoFocus: true,
      draftKey: "server_1/thread_1",
      sendContract: "accepted",
      onAcceptSend: mocks.acceptMessage,
      onTyping: mocks.handleTyping,
    }))
    act(() => composerProps.onCancelReply?.())
    expect(mocks.setReplyTo).toHaveBeenCalledWith(null)
  })

  it("uses the same mobile Back handler while loading and after hydration", () => {
    const onBack = vi.fn()
    mockedUseChannelMessageFeed.mockReturnValue(feed({ isLoading: true }))
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderSurface({ onBack }))
    })
    const loadingBack = mockedChannelHeaderSkeleton.mock.calls.at(-1)![0].onBack
    expect(loadingBack).toBe(onBack)
    act(() => loadingBack?.())

    mockedUseChannelMessageFeed.mockReturnValue(feed({ isLoading: false }))
    act(() => renderer.update(renderSurface({ onBack })))
    const hydratedBack = mockedChannelHeader.mock.calls.at(-1)![0].onBack
    expect(hydratedBack).toBe(onBack)
    act(() => hydratedBack?.())
    expect(onBack).toHaveBeenCalledTimes(2)
  })

  it("preserves regular-thread breadcrumb, rename, panel, and dialog wiring", async () => {
    const props = surfaceProps()
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(React.createElement(ThreadChannelSurface, props))
    })
    let headerProps = mockedChannelHeader.mock.calls.at(-1)![0]
    expect(headerProps).toEqual(expect.objectContaining({ channel: "general", forum: false }))
    expect(headerProps).toEqual(expect.objectContaining({
      notifLevel: "default",
      onSetNotifLevel: props.onSetNotificationLevel,
      onBack: props.onBack,
    }))
    expect(headerProps.breadcrumb).toEqual(expect.objectContaining({
      label: "Thread name",
      titleRename: false,
      onRename: expect.any(Function),
    }))

    await act(async () => {
      await headerProps.breadcrumb?.onRename?.("Renamed thread")
    })
    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/community/channels/thread_1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed thread" }),
    })
    headerProps = mockedChannelHeader.mock.calls.at(-1)![0]
    expect(headerProps.breadcrumb?.label).toBe("Renamed thread")
    act(() => headerProps.breadcrumb?.onNavigateBack())
    expect(mocks.router.replace).toHaveBeenCalledWith("/c/channels/server_1/parent_1")

    act(() => headerProps.onToggle("pinned"))
    const panelProps = mockedCommunityPanel.mock.calls.at(-1)![0]
    expect(panelProps).toEqual(expect.objectContaining({
      kind: "pinned",
      pinned: expect.arrayContaining([expect.objectContaining({ id: "pinned_1" })]),
      searchQuery: "query",
      onOpenThread: props.onOpenChild,
      onJumpToMessage: mocks.jumpToSeq,
      onSearch: mocks.search,
    }))
    const contextProps = mockedMessageContextSheet.mock.calls.at(-1)![0]
    expect(contextProps).toEqual(expect.objectContaining({
      open: true,
      channelId: "source_1",
      channelLabel: "source",
      targetSeq: 4,
      onOpenProfile: props.onOpenProfile,
    }))
    act(() => contextProps.onOpenChange(false))
    expect(mocks.setContextTarget).toHaveBeenCalledWith(null)
    expect(renderer!.root.findByProps({ "data-manage-dialog": true })).toBeTruthy()
  })

  it("uses the forum opener-message rename path only for the post creator", async () => {
    act(() => {
      TestRenderer.create(renderSurface({ parentIsForum: true, channelName: "Post title" }))
    })
    let headerProps = mockedChannelHeader.mock.calls.at(-1)![0]
    expect(headerProps).toEqual(expect.objectContaining({ channel: "general", forum: true }))
    expect(headerProps.breadcrumb).toEqual(expect.objectContaining({
      label: "Post title",
      titleRename: true,
      onRename: expect.any(Function),
    }))
    expect(mockedMessageList.mock.calls.at(-1)![0].hero).toBeUndefined()

    await act(async () => {
      await headerProps.breadcrumb?.onRename?.("Renamed post")
    })
    expect(mocks.editMessage).toHaveBeenCalledWith({
      serverId: "server_1",
      channelId: "parent_1",
      messageId: "opener_1",
      content: "Renamed post",
      forumChannelId: "parent_1",
      forumThreadId: "thread_1",
    })

    act(() => {
      TestRenderer.create(renderSurface({ parentIsForum: true, childCreatorId: "other_user" }))
    })
    headerProps = mockedChannelHeader.mock.calls.at(-1)![0]
    expect(headerProps.breadcrumb?.onRename).toBeUndefined()
  })

  it("preserves rename errors for regular threads and forum posts", async () => {
    const threadError = new Error("thread rename failed")
    mocks.apiFetch.mockRejectedValueOnce(threadError)
    act(() => {
      TestRenderer.create(renderSurface())
    })
    const threadRename = mockedChannelHeader.mock.calls.at(-1)![0].breadcrumb?.onRename
    await expect(threadRename?.("Broken thread")).rejects.toBe(threadError)
    expect(mocks.toastApiError).toHaveBeenCalledWith(threadError, "Failed to rename")

    const postError = new Error("post rename failed")
    mocks.editMessage.mockRejectedValueOnce(postError)
    act(() => {
      TestRenderer.create(renderSurface({ parentIsForum: true }))
    })
    const postRename = mockedChannelHeader.mock.calls.at(-1)![0].breadcrumb?.onRename
    await expect(postRename?.("Broken post")).rejects.toBe(postError)
    expect(mocks.toastApiError).toHaveBeenCalledWith(postError, "Failed to edit post")
  })
})
