import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChannelRoute } from "./channel-route"
import { MessageList } from "./message-list"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"

const { mockRouteModel } = vi.hoisted(() => ({
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
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => ({ get: (key: string) => key === "msg" ? "m_target" : null }),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(), toastApiError: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/components/community/channel-header", () => ({
  ChannelHeader: () => null,
  ChannelHeaderSkeleton: () => null,
}))
vi.mock("@/components/community/message-list", () => ({ MessageList: vi.fn(() => null) }))
vi.mock("@/components/community/composer", () => ({
  Composer: () => null,
  ComposerSkeleton: () => null,
}))
vi.mock("@/components/community/forum-view", () => ({ ForumViewSkeleton: () => null }))
vi.mock("@/components/community/forum-surface", () => ({ ForumSurface: () => null }))
vi.mock("@/components/community/channel-shell", () => ({
  ChannelShell: ({ body }: { body: React.ReactNode }) => body,
}))
vi.mock("@/components/community/community-panel-sheet", () => ({ CommunityPanelSheet: () => null }))
vi.mock("@/components/community/message-context-sheet", () => ({ MessageContextSheet: () => null }))
vi.mock("@/components/community/thread-opener", () => ({ ThreadOpener: () => null }))
vi.mock("@/components/community/add-members-dialog", () => ({ AddMembersDialog: () => null }))
vi.mock("@/components/community/_types", () => ({ canManageServer: () => false }))
vi.mock("@alook/shared", () => ({
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

describe("ChannelRoute top-level text scroll target ownership", () => {
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
    mockedUseChannelMessageFeed.mockImplementation(({ channelId }) =>
      channelId === null ? feed() : surfaceFeed,
    )
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })

    expect(mockedUseChannelMessageFeed.mock.calls.filter(([options]) => options.channelId !== null)).toHaveLength(1)
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({ channelId: null }))
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
    mockedUseChannelMessageFeed.mockImplementation(({ channelId }) =>
      channelId === null ? feed() : surfaceFeed,
    )
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

    expect(mockedUseChannelMessageFeed).toHaveBeenCalledTimes(1)
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({ channelId: null }))
  })

  it("initializes only the child feed for a thread route", () => {
    Object.assign(mockRouteModel, {
      channel: null,
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
})
