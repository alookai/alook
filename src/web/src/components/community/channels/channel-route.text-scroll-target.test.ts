import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChannelRoute } from "./channel-route"
import { ForumChannelSurface } from "./forum-channel-surface"
import { MessageList } from "../messages/message-list"
import { useChannelMemberViewModel } from "../members/channel-member-view-model"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"

const {
  mockRouteModel,
  mockMemberViewModel,
  mockRouter,
  mockUiHandlers,
  mockBreakpoint,
  mockHeaderServerNavigate,
  mockHeaderParentNavigate,
  mockOpenerGate,
  mockSearchParams,
  mockSplitMode,
  mockSplitParentSurface,
  mockCommitLastCommunityRoute,
  mockNavigationGate,
  mockCurrentChannelId,
} = vi.hoisted(() => ({
  mockRouter: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  mockUiHandlers: { replacePath: vi.fn(), goBackMobile: vi.fn() },
  mockBreakpoint: { value: "desktop" as "desktop" | "mobile" },
  mockHeaderServerNavigate: { current: undefined as undefined | (() => void) },
  mockHeaderParentNavigate: { current: undefined as undefined | (() => void) },
  mockOpenerGate: vi.fn(() => null),
  mockSearchParams: { value: "msg=m_target&keep=1" },
  mockSplitMode: { value: "full" as "split" | "full" },
  mockSplitParentSurface: vi.fn(() => null),
  mockCommitLastCommunityRoute: vi.fn(),
  mockNavigationGate: { allowed: true },
  mockCurrentChannelId: { value: "channel_1" as string | null },
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
    routeLifecycle: "ready" as "pending" | "ready" | "terminal-error",
  },
  mockMemberViewModel: {
    composerMembers: [],
    composerMentionCandidates: undefined,
    memberPanelProps: { members: [] },
    manageMembersDialog: null,
    resolveUserName: (userId: string) => userId,
    myRole: "member",
  },
}))

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/c/channels/server_1/channel_1",
  useSearchParams: () => new URLSearchParams(mockSearchParams.value),
}))
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }))
vi.mock("@/lib/community/conversation-navigation-proof", () => ({
  useConversationNavigationGate: () => ({ required: false, allowed: mockNavigationGate.allowed }),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(), toastApiError: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mockBreakpoint.value }))
vi.mock("@/hooks/community/thread-opener-read-handoff", () => ({
  THREAD_OPENER_HANDOFF_PARAM: "inboxThreadOpener",
  useClaimThreadOpenerReadHandoff: vi.fn(),
  useThreadOpenerRouteGate: (...args: unknown[]) => mockOpenerGate(...args),
}))
vi.mock("@/components/community/channels/channel-header", () => ({
  ChannelHeader: ({
    mobileBack,
    kind,
    endActions,
  }: {
    mobileBack?: () => void
    kind?: string
    endActions?: React.ReactNode
  }) => {
    mockHeaderServerNavigate.current = kind === "thread" ? undefined : mobileBack
    mockHeaderParentNavigate.current = kind === "thread" ? mobileBack : undefined
    return React.createElement(React.Fragment, null, endActions)
  },
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
  ChannelShell: ({ header, body }: { header: React.ReactNode; body: React.ReactNode }) =>
    React.createElement(React.Fragment, null, header, body),
}))
vi.mock("@/components/community/shell/community-panel", () => ({ CommunityPanel: () => null }))
vi.mock("@/components/community/messages/message-context-sheet", () => ({ MessageContextSheet: () => null }))
vi.mock("@/components/community/messages/thread-opener", () => ({ ThreadOpener: () => null }))
vi.mock("@/components/community/members/add-members-dialog", () => ({ AddMembersDialog: () => null }))
vi.mock("@alook/shared", () => ({
  canManageServer: () => false,
  devWsDoPort: () => 8789,
  isForum: () => false,
  deriveThreadName: () => "thread",
  USE_SERVER_DEFAULT: "default",
}))
vi.mock("@/lib/community/last-channel", () => ({ setLastChannel: vi.fn() }))
vi.mock("@/lib/community/last-community-route", () => ({
  commitLastCommunityRoute: (...args: unknown[]) => mockCommitLastCommunityRoute(...args),
}))
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
    useCurrentChannelId: () => mockCurrentChannelId.value,
    useUiHandlers: () => mockUiHandlers,
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
vi.mock("@/hooks/community/use-thread-split-mode", () => ({
  useThreadSplitMode: () => ({ containerRef: vi.fn(), mode: mockSplitMode.value }),
}))
vi.mock("@/components/community/channels/thread-split-parent-surface", () => ({
  ThreadSplitParentSurface: mockSplitParentSurface,
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
  communityWsClaimSecondaryChannel: vi.fn(),
  communityWsReleaseSecondaryChannel: vi.fn(),
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
    mockOpenerGate.mockClear()
    mockSearchParams.value = "msg=m_target&keep=1"
    mockSplitMode.value = "full"
    mockSplitParentSurface.mockClear()
    mockBreakpoint.value = "desktop"
    mockHeaderServerNavigate.current = undefined
    mockHeaderParentNavigate.current = undefined
    mockCommitLastCommunityRoute.mockClear()
    mockNavigationGate.allowed = true
    mockCurrentChannelId.value = "channel_1"
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
      routeLifecycle: "ready",
    })
  })

  it("forwards the route lifecycle and canonical child tuple to the opener gate", () => {
    configureThreadRoute()
    mockRouteModel.routeLifecycle = "pending"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    act(() => {
      TestRenderer.create(React.createElement(ChannelRoute, {
        serverId: "server_1",
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })
    expect(mockOpenerGate).toHaveBeenCalledWith({
      serverId: "server_1",
      childChannelId: "channel_1",
      parentChannelId: "parent_1",
      openerMessageId: "opener_1",
      lifecycle: "pending",
    })
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
  })

  it.each([
    ["pending", true],
    ["ready", false],
  ] as const)("keeps %s metadata neutral while access=%s", (routeLifecycle, accessAllowed) => {
    Object.assign(mockRouteModel, {
      channel: { id: "channel_1", name: "cached-forum", type: "forum" },
      isForum: true,
      routeLifecycle,
    })
    mockNavigationGate.allowed = accessAllowed
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })

    expect(renderer.root.findByProps({
      "data-community-conversation-subtype": "unknown",
    })).toBeDefined()
    expect(mockedForumChannelSurface).not.toHaveBeenCalled()
    expect(mockedMessageList).not.toHaveBeenCalled()
  })

  it("mounts authoritative split geometry before a thread body is active", () => {
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockCurrentChannelId.value = null
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })

    expect(renderer.root.findByProps({ "data-testid": "community-thread-split" }).props["data-layout"])
      .toBe("split")
    expect(renderer.root.findByProps({ "data-testid": "community-thread-split-parent" }))
      .toBeDefined()
    expect(renderer.root.findByProps({ "data-testid": "community-thread-split-panel" }))
      .toBeDefined()
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
  })

  it("commits only a ready channel route for the active account", () => {
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    act(() => {
      TestRenderer.create(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })
    expect(mockCommitLastCommunityRoute).toHaveBeenCalledWith(
      "viewer_1",
      "/c/channels/server_1/channel_1",
    )
  })

  it("defers child msg cleanup until the handoff nonce has its own cleanup", () => {
    mockSearchParams.value = "inboxThreadOpener=nonce-1&msg=m_target&keep=1"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })
    expect(mockRouter.replace).not.toHaveBeenCalled()

    mockSearchParams.value = "msg=m_target&keep=1"
    act(() => {
      renderer.update(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })
    expect(mockRouter.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1?keep=1",
      { scroll: false },
    )
  })

  it("composes a wide child route as parent + thread with fullscreen and close actions", () => {
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockSearchParams.value = "keep=1"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })

    expect(renderer.root.findByProps({ "data-testid": "community-thread-split" }).props["data-layout"]).toBe("split")
    expect(mockSplitParentSurface).toHaveBeenCalledWith(expect.objectContaining({
      channel: expect.objectContaining({ id: "parent_1", type: "text" }),
    }), undefined)

    act(() => renderer.root.findByProps({ "data-testid": "community-thread-split-fullscreen" }).props.onClick())
    expect(mockRouter.push).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1?keep=1&threadView=full",
      { scroll: false },
    )

    act(() => renderer.root.findByProps({ "data-testid": "community-thread-split-close" }).props.onClick())
    expect(mockUiHandlers.replacePath).toHaveBeenCalledWith("/c/channels/server_1/parent_1")
  })

  it("uses the same split parent contract for a forum post", () => {
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockRouteModel.parent = { id: "parent_1", name: "questions", type: "forum" }
    mockRouteModel.isForumPostChild = true
    mockRouteModel.server.categories = [{
      channels: [{ id: "parent_1", name: "questions", type: "forum" }],
    }]
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    act(() => {
      TestRenderer.create(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })

    expect(mockSplitParentSurface).toHaveBeenCalledWith(expect.objectContaining({
      channel: expect.objectContaining({ id: "parent_1", type: "forum" }),
    }), undefined)
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
    expect(mockRouter.replace).toHaveBeenLastCalledWith(
      "/c/channels/server_1/channel_1?keep=1",
      { scroll: false },
    )
  })

  it("replaces directly to the verified parent from the child Back control", () => {
    configureThreadRoute()
    mockBreakpoint.value = "mobile"
    mockedUseChannelMessageFeed.mockImplementation(() => feed({ anchorInCache: true }))

    act(() => {
      TestRenderer.create(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    act(() => mockHeaderParentNavigate.current?.())

    expect(mockUiHandlers.replacePath).toHaveBeenCalledWith(
      "/c/channels/server_1/parent_1",
    )
    expect(mockUiHandlers.goBackMobile).not.toHaveBeenCalled()
  })

  it("replaces directly to the canonical server root from a top-level channel", () => {
    mockBreakpoint.value = "mobile"
    mockedUseChannelMessageFeed.mockImplementation(() => feed())

    act(() => {
      TestRenderer.create(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    act(() => mockHeaderServerNavigate.current?.())

    expect(mockUiHandlers.replacePath).toHaveBeenCalledWith(
      "/c/channels/server_1",
    )
    expect(mockUiHandlers.goBackMobile).not.toHaveBeenCalled()
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
