import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChannelRoute } from "./channel-route"
import { ForumChannelSurface } from "./forum-channel-surface"
import { MessageList } from "../messages/message-list"
import { useChannelMemberViewModel } from "../members/channel-member-view-model"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"

const { mockRouteModel, mockMemberViewModel, mockRouter } = vi.hoisted(() => ({
  mockRouter: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  mockRouteModel: {
    server: {
      id: "server_1",
      name: "Server",
      icon: null,
      categories: [{ channels: [{ id: "channel_1", name: "general", type: "text" }] }],
    },
    channel: { id: "channel_1", name: "general", type: "text" },
    parent: null,
    currentChannelMeta: null as null | {
      id: string
      name: string
      parentChannelId: string
      parentMessageId: string | null
      creatorId: string
    },
    isForum: false,
    isChild: false,
    isForumPostChild: false,
    isNotifyUnit: false,
    routeHydrated: true,
  },
  mockMemberViewModel: {
    composerMembers: [],
    onSearchComposerMembers: vi.fn(),
    memberPanelProps: { members: [] },
    manageMembersDialog: null,
    resolveUserName: (userId: string) => userId,
    myRole: "member",
  },
}))

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams("msg=m_target&keep=1"),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(), toastApiError: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/components/community/channels/channel-header", () => ({
  ChannelHeader: () => null,
  ChannelHeaderSkeleton: () => null,
}))
vi.mock("@/components/community/messages/message-list", () => ({ MessageList: vi.fn(() => null) }))
vi.mock("@/components/community/messages/composer", () => ({
  Composer: () => null,
  ComposerSkeleton: () => null,
}))
vi.mock("@/components/community/channels/forum-view", () => ({ ForumViewSkeleton: () => null }))
vi.mock("@/components/community/channels/forum-channel-surface", () => ({
  ForumChannelSurface: vi.fn(() => null),
}))
vi.mock("@/components/community/members/channel-member-view-model", () => ({
  useChannelMemberViewModel: vi.fn(() => mockMemberViewModel),
}))
vi.mock("@/components/community/channels/channel-shell", () => ({
  ChannelShell: ({ body }: { body: React.ReactNode }) => body,
}))
vi.mock("@/components/community/shell/community-panel-sheet", () => ({ CommunityPanelSheet: () => null }))
vi.mock("@/components/community/messages/message-context-sheet", () => ({ MessageContextSheet: () => null }))
vi.mock("@/components/community/messages/thread-opener", () => ({ ThreadOpener: () => null }))
vi.mock("@/components/community/members/add-members-dialog", () => ({ AddMembersDialog: () => null }))
vi.mock("@alook/shared", () => ({
  canManageServer: () => false,
  isForum: () => false,
  deriveThreadName: () => "thread",
  USE_SERVER_DEFAULT: "default",
}))
vi.mock("@/lib/community/last-channel", () => ({ setLastChannel: vi.fn() }))
vi.mock("@/stores/community", () => {
  const state = {
    pendingReply: null,
    setPendingReply: vi.fn(),
    registerUiHandlers: vi.fn(),
  }
  const useCommunityStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return {
    useCommunityStore,
    useCurrentChannelId: () => "channel_1",
    useUiHandlers: () => ({}),
    useTypingUsersForScope: () => [],
    useTypingNamesForScope: () => ({}),
  }
})
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer_1", name: "Viewer", avatar: "V" }),
}))
vi.mock("@/hooks/community/use-channel-route-model", () => ({
  useChannelRouteModel: () => mockRouteModel,
}))
vi.mock("@/hooks/community/use-forum-opener-hint", () => ({
  useForumOpenerHint: () => ({ data: null, isLoading: false }),
}))
vi.mock("@/hooks/community/use-server-members", () => ({
  useServerMembers: () => ({
    members: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    loadMore: vi.fn(),
    searchMembers: vi.fn(),
  }),
}))
vi.mock("@/hooks/community/use-channel-members", () => ({
  useChannelMembers: () => ({ members: [], isLoading: false }),
  useAddableMembers: () => ({ members: [] }),
  useAddChannelMember: () => ({ mutateAsync: vi.fn() }),
  useRemoveChannelMember: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock("@/hooks/community/use-thread-participants", () => ({
  useAddThreadParticipant: () => ({ mutateAsync: vi.fn() }),
  useRemoveThreadParticipant: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock("@/hooks/community/use-message", () => ({
  useMessage: () => ({ message: null, isLoading: false }),
}))
vi.mock("@/hooks/community/use-channel-message-feed", () => ({
  useChannelMessageFeed: vi.fn(),
}))
vi.mock("@/hooks/community/use-notification-settings", () => ({
  useNotificationSettings: () => ({ channel: {} }),
}))
vi.mock("@/stores/community/ws", () => ({
  useOnlineUserIds: () => new Set(),
  useCommunityWsStore: (selector: (state: { userStatuses: Map<string, unknown> }) => unknown) =>
    selector({ userStatuses: new Map() }),
}))
vi.mock("@/hooks/community/mutations", () => ({
  useSendMessage: () => ({ mutateAsync: vi.fn() }),
  useToggleReactionApi: () => vi.fn(),
  usePinMessage: () => ({ mutate: vi.fn() }),
  useUnpinMessage: () => ({ mutate: vi.fn() }),
  useToggleMark: () => vi.fn(),
  useEditMessage: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useCreateThread: () => ({ mutateAsync: vi.fn() }),
  useCreateForumThread: () => ({ mutateAsync: vi.fn() }),
  useUpdatePostTags: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteForumThread: () => ({ mutate: vi.fn(), isPending: false }),
  useSetMemberRole: () => ({ mutate: vi.fn() }),
  useKickMember: () => ({ mutateAsync: vi.fn() }),
  useSetChannelNotif: () => ({ mutate: vi.fn() }),
  useUploadFile: () => ({ mutateAsync: vi.fn() }),
  zipUploadResultsWithDimensions: () => [],
  sendNonce: () => "nonce_1",
}))
vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsSendTyping: vi.fn(),
  communityWsResetTypingThrottle: vi.fn(),
}))

const mockedMessageList = vi.mocked(MessageList)
const mockedUseChannelMessageFeed = vi.mocked(useChannelMessageFeed)
const mockedUseChannelMemberViewModel = vi.mocked(useChannelMemberViewModel)
const mockedForumChannelSurface = vi.mocked(ForumChannelSurface)

function feed(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    isLoading: false,
    isError: false,
    isFetchingOlder: false,
    isFetchingNewer: false,
    hasMoreOlder: false,
    hasMoreNewer: false,
    fetchOlder: vi.fn(),
    fetchNewer: vi.fn(),
    jumpToPresent: vi.fn(),
    latestSeq: 0,
    readSnapshot: null,
    readSnapshotFetching: false,
    newDividerBefore: undefined,
    anchorInCache: false,
    unreadCount: 0,
    setScrollRootEl: vi.fn(),
    threads: [],
    threadsLoading: false,
    pinned: [],
    pinnedLoading: false,
    ...overrides,
  } as ReturnType<typeof useChannelMessageFeed>
}

function configureThreadRoute() {
  Object.assign(mockRouteModel, {
    channel: null,
    parent: { id: "parent_1", name: "general", type: "text" },
    currentChannelMeta: {
      id: "channel_1",
      name: "thread",
      parentChannelId: "parent_1",
      parentMessageId: "opener_1",
      creatorId: "viewer_1",
    },
    isChild: true,
    isNotifyUnit: true,
  })
  mockRouteModel.server.categories = [{
    channels: [{ id: "parent_1", name: "general", type: "text" }],
  }]
}

describe("ChannelRoute message surface ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockedMessageList.mockClear()
    Object.assign(mockRouteModel, {
      server: {
        id: "server_1",
        name: "Server",
        icon: null,
        categories: [{ channels: [{ id: "channel_1", name: "general", type: "text" }] }],
      },
      channel: { id: "channel_1", name: "general", type: "text" },
      parent: null,
      currentChannelMeta: null,
      isForum: false,
      isChild: false,
      isForumPostChild: false,
      isNotifyUnit: false,
      routeHydrated: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("keeps the route anchor until MessageList reports a successful jump", () => {
    let surfaceFeed = feed({ messages: [{ id: "m_unrelated" }] })
    mockedUseChannelMessageFeed.mockImplementation(() => surfaceFeed)
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })

    expect(mockedUseChannelMessageFeed).toHaveBeenCalledTimes(1)
    expect(mockRouter.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1?keep=1",
      { scroll: false },
    )
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({ channelId: "channel_1" }))
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")

    surfaceFeed = feed({ messages: [{ id: "m_target" }] })
    act(() => {
      renderer!.update(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })

    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")
    act(() => vi.advanceTimersByTime(5000))
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")
    act(() => mockedMessageList.mock.calls.at(-1)?.[0].onScrollTargetConsumed?.("m_target"))
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBeNull()
  })

  it("clears the route anchor only after the authoritative anchor request errors", () => {
    let surfaceFeed = feed({ messages: [{ id: "m_unrelated" }] })
    mockedUseChannelMessageFeed.mockImplementation(() => surfaceFeed)
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })

    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")
    surfaceFeed = feed({ messages: [{ id: "m_unrelated" }], isError: true })
    act(() => {
      renderer!.update(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBeNull()
  })

  it("does not initialize an active message feed for a forum route", () => {
    Object.assign(mockRouteModel, {
      channel: { id: "channel_1", name: "forum", type: "forum" },
      isForum: true,
    })
    mockedUseChannelMessageFeed.mockImplementation(() => feed())

    act(() => {
      TestRenderer.create(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })

    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    expect(mockedUseChannelMemberViewModel).toHaveBeenCalledTimes(1)
    expect(mockedForumChannelSurface).toHaveBeenCalledTimes(1)
    expect(mockedForumChannelSurface).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "channel_1",
      serverId: "server_1",
    }), undefined)
  })

  it("initializes only the child feed for a thread route", () => {
    configureThreadRoute()
    mockedUseChannelMessageFeed.mockImplementation(() => feed({ anchorInCache: true }))

    act(() => {
      TestRenderer.create(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })

    expect(mockedUseChannelMessageFeed).toHaveBeenCalledTimes(1)
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "channel_1",
      isChildChannel: true,
    }))
  })

  it("keeps a child target through warm cache and 5000ms until MessageList consumes it", () => {
    configureThreadRoute()
    let childFeed = feed({ messages: [{ id: "m_unrelated" }], anchorInCache: true })
    mockedUseChannelMessageFeed.mockImplementation(() => childFeed)
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })

    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")
    childFeed = feed({ messages: [{ id: "m_target" }], anchorInCache: true })
    act(() => {
      renderer!.update(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    act(() => vi.advanceTimersByTime(5000))
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")
    act(() => mockedMessageList.mock.calls.at(-1)?.[0].onScrollTargetConsumed?.("m_target"))
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBeNull()
  })

  it("clears a missing child target only after the child feed errors", () => {
    configureThreadRoute()
    let childFeed = feed({ messages: [{ id: "m_unrelated" }], anchorInCache: true })
    mockedUseChannelMessageFeed.mockImplementation(() => childFeed)
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")

    childFeed = feed({ messages: [{ id: "m_unrelated" }], isError: true, anchorInCache: true })
    act(() => {
      renderer!.update(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBeNull()
  })
})
