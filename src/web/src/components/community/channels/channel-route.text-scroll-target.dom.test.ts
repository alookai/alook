import React from "react"
import { renderToString } from "react-dom/server"
import { QueryClientProvider } from "@tanstack/react-query"
import { CommunityDbProvider, useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { act, fireEvent, screen } from "@/test/react-dom-harness"
import { renderCommunity as render, renderCommunityHook } from "@/test/community-owner-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChannelRoute } from "./channel-route"
import { ThreadSplitView } from "./thread-split-view"
import { useChannelRouteModel } from "@/hooks/community/use-channel-route-model"
import { ForumChannelSurface } from "./forum-channel-surface"
import { MessageList } from "../messages/message-list"
import { useChannelMemberViewModel } from "../members/channel-member-view-model"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import type { ConversationNavigationTarget } from "@/lib/community/conversation-navigation-warmup"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { runAuthoritativeServerEject } from "@/lib/community/eject-server"
import { CommunityServerModuleHost as ServerLayout } from "@/test/community-module-host"
import { channelSchema } from "@/lib/community-db/schema"
import { conversationEntryFixture } from "@/test/conversation-entry-fixtures"

const {
  mockRouteModel,
  mockMemberViewModel,
  mockRouter,
  mockUiHandlers,
  mockBreakpoint,
  mockHeaderServerNavigate,
  mockHeaderParentNavigate,
  mockOpenerGate,
  mockForumOpener,
  mockSearchParams,
  mockSplitMode,
  mockSplitContainerRef,
  mockUseThreadSplitMode,
  mockSplitParentSurface,
  mockCommitLastCommunityRoute,
  mockSetLastChannel,
  mockClearLastChannel,
  mockNavigationGate,
  mockCurrentChannelId,
  mockCanManageServer,
  mockDismissConversation,
  mockParentMetadata,
  mockNavigation,
  mockPathname,
  mockViewerId,
  mockClaimSecondary,
  mockReleaseSecondary,
  mockUseChannelMetadata,
} = vi.hoisted(() => ({
  mockRouter: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  mockUiHandlers: { replacePath: vi.fn(), goBackMobile: vi.fn(), cancelPendingNavigation: vi.fn() },
  mockBreakpoint: { value: "desktop" as "desktop" | "mobile" | "unknown" },
  mockHeaderServerNavigate: { current: undefined as undefined | (() => void) },
  mockHeaderParentNavigate: { current: undefined as undefined | (() => void) },
  mockOpenerGate: vi.fn(() => null),
  mockForumOpener: { data: null as null | { content: string }, isLoading: false, isError: false, error: null as Error | null, isFetching: false, refetch: vi.fn(() => Promise.resolve()) },
  mockSearchParams: { value: "msg=m_target&keep=1" },
  mockSplitMode: { value: "full" as "pending" | "split" | "full" },
  mockSplitContainerRef: vi.fn(),
  mockUseThreadSplitMode: vi.fn<typeof import("@/hooks/community/use-thread-split-mode").useThreadSplitMode>(),
  mockSplitParentSurface: vi.fn((_props: Record<string, unknown>): React.ReactNode => null),
  mockCommitLastCommunityRoute: vi.fn(),
  mockSetLastChannel: vi.fn(),
  mockClearLastChannel: vi.fn(),
  mockNavigationGate: { allowed: true, target: null as ConversationNavigationTarget | null },
  mockCurrentChannelId: { value: "channel_1" as string | null },
  mockCanManageServer: vi.fn((role?: string | null) => role === "owner" || role === "admin"),
  mockDismissConversation: vi.fn(),
  mockParentMetadata: { identityKnown: false, canRead: false, status: "pending", retrying: false, retry: vi.fn() },
  mockNavigation: { entryIntent: null as { href: string; resume?: boolean } | null, push: vi.fn(), navigationPending: false, pendingHref: null as string | null },
  mockPathname: { value: "/c/channels/server_1/channel_1" },
  mockViewerId: { value: "viewer_1" },
  mockClaimSecondary: vi.fn(),
  mockReleaseSecondary: vi.fn(),
  mockUseChannelMetadata: vi.fn(),
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
    serverError: false,
    retryingServer: false,
    retryServer: vi.fn(),
    metadataError: false,
    retryingMetadata: false,
    retryMetadata: vi.fn(),
    routeHydrated: true,
    routeLifecycle: "ready" as "pending" | "ready" | "terminal-error",
    skeletonSubtype: "unknown" as "unknown" | "text" | "forum" | "thread",
    layoutHint: {
      subtype: "unknown" as "unknown" | "text" | "forum" | "thread",
      parentChannelId: null as string | null,
      parentSubtype: "unknown" as "unknown" | "text" | "forum",
    },
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

vi.mock("@/components/brand/alook-loading/AlookLoading", () => ({
  AlookLoading: () => null,
}))

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => mockPathname.value,
  useSelectedLayoutSegments: () => mockPathname.value.split("/").slice(3),
  useSearchParams: () => new URLSearchParams(mockSearchParams.value),
}))
vi.mock("@/components/community/shell/community-route-context", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/community/shell/community-route-context")>(),
  useCommunityRouteFrame: () => ({ navigation: mockNavigation, breakpoint: mockBreakpoint.value, frame: { revision: 0 } }),
}))
vi.mock("@/hooks/community/use-channel-metadata", () => ({
  useChannelMetadata: (...args: unknown[]) => { mockUseChannelMetadata(...args); return mockParentMetadata },
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(), toastApiError: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockBreakpoint.value === "mobile", useBreakpoint: () => mockBreakpoint.value }))
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
    return React.createElement("header", { "data-header-kind": kind }, endActions)
  },
  ChannelHeaderSkeleton: ({ kind = "text" }: { kind?: string }) =>
    React.createElement("div", { "data-testid": "channel-header-skeleton", "data-kind": kind }),
}))
vi.mock("@/components/community/messages/message-list", () => ({ MessageList: vi.fn(() => null) }))
vi.mock("@/components/community/channels/conversation-message-skeleton", () => ({
  ConversationMessageSkeleton: () => React.createElement("div", { "data-message-list-skeleton": true }),
}))
vi.mock("@/components/community/messages/composer", () => ({
  Composer: ({ draftKey }: { draftKey: string }) => React.createElement("textarea", { "data-draft-key": draftKey }),
  ComposerSkeleton: () => null,
}))
vi.mock("@/components/community/channels/forum-view", () => ({
  ForumViewSkeleton: () => React.createElement("div", { "data-testid": "forum-view-skeleton" }),
}))
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
vi.mock("@alook/shared", async (importOriginal) => ({ ...await importOriginal<typeof import("@alook/shared")>(),
  canManageServer: mockCanManageServer,
  devWsDoPort: () => 8789,
  isForum: () => false,
  deriveThreadName: () => "thread",
  USE_SERVER_DEFAULT: "default",
 }))
vi.mock("@/lib/community/last-channel", () => ({
  setLastChannel: (...args: unknown[]) => mockSetLastChannel(...args),
  clearLastChannel: (...args: unknown[]) => mockClearLastChannel(...args),
}))
vi.mock("@/lib/community/last-community-route", () => ({
  commitCommunityChannelRoute: (accountId: string, serverId: string, channelId: string) => {
    mockSetLastChannel(serverId, channelId)
    mockCommitLastCommunityRoute(accountId, `/c/channels/${serverId}/${channelId}`)
  },
}))
vi.mock("@/stores/community", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/community")>();
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
    ...actual,
    useCommunityStore,
    useCurrentChannelId: () => mockCurrentChannelId.value,
    useUiHandlers: () => mockUiHandlers,
    useTypingUsersForScope: () => [],
    useTypingNamesForScope: () => ({}),
  }
})
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: mockViewerId.value, name: "Viewer", avatar: "V" }),
}))
vi.mock("@/hooks/community/use-channel-route-model", () => ({
  useChannelRouteModel: vi.fn(() => mockRouteModel),
}))
vi.mock("@/hooks/community/use-native-system-notifications", () => ({
  useNativeSystemNotificationConversationDismissal: (...args: unknown[]) =>
    mockDismissConversation(...args),
}))
vi.mock("@/hooks/community/use-thread-split-mode", () => ({
  useThreadSplitMode: (options: Parameters<typeof mockUseThreadSplitMode>[0]) =>
    mockUseThreadSplitMode(options) ?? { containerRef: mockSplitContainerRef, mode: mockSplitMode.value },
}))
vi.mock("@/components/community/channels/thread-split-parent-surface", () => ({
  ThreadSplitParentSurface: mockSplitParentSurface,
}))
vi.mock("@/components/community/channels/thread-split-view", () => ({
  ThreadSplitView: vi.fn(({
    split,
    layoutPending = false,
    parent,
    thread,
    conversationSubtype,
    resolvingParent,
  }: {
    split: boolean
    layoutPending?: boolean
    parent: React.ReactNode
    thread: React.ReactNode
    conversationSubtype?: string
    resolvingParent?: boolean
  }) => React.createElement(
    "main",
    {
      "data-testid": conversationSubtype === "thread" ? "community-thread-split" : undefined,
      "data-layout": layoutPending || resolvingParent ? "pending" : split ? "split" : "full",
      "data-layout-pending": layoutPending || undefined,
      "data-community-conversation-subtype": conversationSubtype === "unknown" ? undefined : conversationSubtype,
    },
    resolvingParent && React.createElement("main", { "aria-label": "Resolving conversation", "data-community-conversation-subtype": "unknown" }),
    (split || layoutPending) && React.createElement(
      "section",
      { "data-testid": "community-thread-split-parent", "data-thread-parent": "", inert: !split },
      parent,
    ),
    React.createElement(
      "section",
      { "data-testid": conversationSubtype === "thread" ? "community-thread-split-panel" : undefined },
      thread,
    ),
  )),
}))
vi.mock("@/hooks/community/use-forum-opener-hint", () => ({
  useForumOpenerHint: () => mockForumOpener,
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
vi.mock("@/stores/community/ws", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community/ws")>(),
  useOnlineUserIds: () => new Set(),
  useCommunityWsStore: (selector: (state: { userStatuses: Map<string, unknown> }) => unknown) =>
    selector({ userStatuses: new Map() }),
}))
vi.mock("@/hooks/community/mutations", () => ({
  useSendMessage: () => ({ mutateAsync: vi.fn() }),
  useToggleReactionApi: () => vi.fn(),
  useAddReactionApi: () => vi.fn(),
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
}))
vi.mock("@/hooks/community/mutations/messages", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/community/mutations/messages")>(),
  sendNonce: () => "nonce_1",
}))
vi.mock("@/hooks/community/mutations/uploads", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/community/mutations/uploads")>(),
  zipUploadResultsWithDimensions: () => [],
}))
vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsSendTyping: vi.fn(),
  communityWsEndTyping: vi.fn(),
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
    skeletonSubtype: "thread",
    layoutHint: { subtype: "thread", parentChannelId: "parent_1", parentSubtype: "text" },
  })
  mockParentMetadata.identityKnown = true
  mockParentMetadata.canRead = true
  mockParentMetadata.status = "readable"
  mockRouteModel.server.categories = [{
    channels: [{ id: "parent_1", name: "general", type: "text" }],
  }]
}

async function observeSecondary() {
  const ws = await import("@/hooks/community/use-community-ws")
  vi.spyOn(ws, "communityWsClaimSecondaryChannel").mockImplementation((...args) => mockClaimSecondary(...args))
  vi.spyOn(ws, "communityWsReleaseSecondaryChannel").mockImplementation((...args) => mockReleaseSecondary(...args))
}

function useMockParentIdentity(props: Record<string, unknown>) {
  const channelId = (props.channel as { id: string }).id
  const onIdentity = props.onIdentity as (id: string, confirmed: boolean) => void
  React.useLayoutEffect(() => {
    onIdentity(channelId, true)
    return () => onIdentity(channelId, false)
  }, [channelId, onIdentity])
}

describe("ChannelRoute message surface ownership", () => {
  beforeEach(() => {
    vi.mocked(useChannelRouteModel).mockImplementation(() => mockRouteModel)
    mockUiHandlers.cancelPendingNavigation.mockClear()
    mockNavigation.push.mockReset()
    mockNavigation.navigationPending = false
    mockNavigation.pendingHref = null
    mockPathname.value = "/c/channels/server_1/channel_1"
    mockViewerId.value = "viewer_1"
    Object.assign(mockParentMetadata, { identityKnown: false, canRead: false, status: "pending", retrying: false })
    vi.useFakeTimers()
    mockedMessageList.mockClear()
    mockOpenerGate.mockClear()
    Object.assign(mockForumOpener, { data: null, isLoading: false, isError: false, error: null, isFetching: false })
    mockForumOpener.refetch.mockClear()
    mockSearchParams.value = "msg=m_target&keep=1"
    mockSplitMode.value = "full"
    mockSplitContainerRef.mockClear()
    mockUseThreadSplitMode.mockReset()
    mockClaimSecondary.mockClear()
    mockReleaseSecondary.mockClear()
    mockUseChannelMetadata.mockClear()
    mockSplitParentSurface.mockReset()
    mockSplitParentSurface.mockImplementation((props) => { useMockParentIdentity(props); return null })
    mockBreakpoint.value = "desktop"
    mockHeaderServerNavigate.current = undefined
    mockHeaderParentNavigate.current = undefined
    mockCommitLastCommunityRoute.mockClear()
    mockSetLastChannel.mockClear()
    mockClearLastChannel.mockClear()
    mockDismissConversation.mockClear()
    mockNavigationGate.allowed = true
    mockNavigationGate.target = null
    mockNavigation.entryIntent = null
    mockCurrentChannelId.value = "channel_1"
    mockMemberViewModel.myRole = "member"
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
      serverError: false,
      retryingServer: false,
      metadataError: false,
      retryingMetadata: false,
      routeHydrated: true,
      routeLifecycle: "ready",
      skeletonSubtype: "unknown",
      layoutHint: { subtype: "unknown", parentChannelId: null, parentSubtype: "unknown" },
    })
  })

  it("keeps the real mobile parent DOM, scroll and draft through child entry and pending resume", async () => {
    const registry = renderCommunityHook(() => useOptionalCommunityDbRegistry()).result.current!
    const parent = { ...mockRouteModel }
    const child = { ...mockRouteModel, channel: null, parent: parent.channel,
      currentChannelMeta: { id: "child_1", name: "Thread", parentChannelId: "channel_1", parentMessageId: "opener_1", creatorId: "viewer_1" },
      isChild: true, isNotifyUnit: true, skeletonSubtype: "thread",
      layoutHint: { subtype: "thread", parentChannelId: "channel_1", parentSubtype: "text" },
    }
    vi.mocked(useChannelRouteModel).mockImplementation((_server, _param, id) => (id === "channel_1" ? parent : child) as never)
    const base = conversationEntryFixture().channel
    registry.collections.channels.utils.writeUpsert([
      channelSchema.parse({ ...base, id: "channel_1", serverId: "server_1", muted: false, unread: false, tags: [], pending: false, resourceComplete: true }),
      channelSchema.parse({ ...base, id: "child_1", serverId: "server_1", type: "thread", parentChannelId: "channel_1", parentMessageId: "opener_1", muted: false, unread: false, tags: [], pending: false, resourceComplete: true }),
    ])
    mockBreakpoint.value = "mobile"
    mockSearchParams.value = ""
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    const node = (id: string, committed = true) => React.createElement(ChannelRoute, {
      serverParam: "server_1", channelId: id, routeCommitted: committed,
    })
    const view = render(node("channel_1"))
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    const composer = view.container.querySelector<HTMLTextAreaElement>('[data-draft-key="server_1/channel_1"]')!
    const pane = composer.closest<HTMLElement>('[data-community-target-href]')!
    pane.scrollTop = 184
    fireEvent.change(composer, { target: { value: "Retained parent draft" } })
    mockCurrentChannelId.value = "child_1"
    view.rerender(node("child_1"))
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(view.container.querySelector('[data-draft-key="server_1/channel_1"]')).toBe(composer)
    expect(composer.closest('[data-mobile-page-active="false"]')).toHaveAttribute("inert")
    expect(pane.scrollTop).toBe(184)
    mockNavigation.entryIntent = { href: "/c/channels/server_1/channel_1", resume: true }
    view.rerender(node("channel_1", false))
    expect(view.container.querySelector('[data-draft-key="server_1/channel_1"]')).toBe(composer)
    expect(composer).toHaveValue("Retained parent draft")
    expect(pane.scrollTop).toBe(184)
    mockCurrentChannelId.value = "channel_1"
    view.rerender(node("channel_1"))
    expect(view.container.querySelector('[data-draft-key="server_1/channel_1"]')).toBe(composer)
    expect(composer).toHaveValue("Retained parent draft")
  })

  it.each(["resumed forum", "forward", "unhydrated", "pending", "text"] as const)("qualifies role display separately from member reads for %s", (boundary) => {
    Object.assign(mockRouteModel, { isForum: true, channel: { id: "channel_1", name: "Forum", type: "forum" }, skeletonSubtype: "forum", layoutHint: { subtype: "forum", parentChannelId: null, parentSubtype: "unknown" } })
    mockBreakpoint.value = "mobile"
    mockSearchParams.value = ""
    mockNavigation.entryIntent = { href: "/c/channels/server_1/channel_1", resume: true }
    if (boundary === "forward") mockNavigation.entryIntent = { href: "/c/channels/server_1/channel_1" }
    if (boundary === "unhydrated") mockRouteModel.routeHydrated = false
    if (boundary === "pending") mockRouteModel.routeLifecycle = "pending"
    if (boundary === "text") mockRouteModel.isForum = false
    render(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1", routeCommitted: false }))
    const model = mockedUseChannelMemberViewModel.mock.calls.at(-1)![0]
    expect(model.accessAllowed).toBe(false)
    expect(model.roleDisplayAllowed ?? false).toBe(boundary === "resumed forum")
  })

  it("keeps the operational opener gate outside pending child content", async () => {
    configureThreadRoute()
    mockRouteModel.routeLifecycle = "pending"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    await act(async () => {
      render(React.createElement(ChannelRoute, {
        serverId: "server_1",
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })
    expect(mockOpenerGate).not.toHaveBeenCalled()
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
  })

  it("keeps the actual server-layout parent through pending B, superseding C and C commit", () => {
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockSearchParams.value = "msg=mA&inboxThreadOpener=nonceA"
    mockedUseChannelMessageFeed.mockReturnValue(feed({ anchorInCache: true }))
    mockSplitParentSurface.mockImplementation((props) => {
      useMockParentIdentity(props)
      const { onOpenChild } = props
      return React.createElement("div", null,
      React.createElement("input", { "data-testid": "parent-draft", defaultValue: "" }),
      React.createElement("div", { "data-testid": "parent-scroll" }, "Parent"),
      React.createElement("button", { onClick: () => (onOpenChild as (id: string) => void)("channel_2") }, "Open B"),
    ) })
    const node = () => React.createElement(ServerLayout, null)
    const renderer = render(node())
    const outer = renderer.container.firstElementChild
    const parent = screen.getByTestId("community-thread-split-parent")
    const draft = screen.getByTestId("parent-draft") as HTMLInputElement
    const scroll = screen.getByTestId("parent-scroll")
    draft.value = "Parent draft"
    scroll.scrollTop = 120
    fireEvent.click(screen.getByRole("button", { name: "Open B" }))
    expect(mockNavigation.push).toHaveBeenCalledExactlyOnceWith("/c/channels/server_1/channel_2", { scroll: false })
    mockNavigation.navigationPending = true
    mockNavigation.pendingHref = "/c/channels/server_1/channel_2?msg=mB&inboxThreadOpener=nonceB"
    Object.assign(mockRouteModel, { currentChannelMeta: null, routeHydrated: false, routeLifecycle: "pending" })
    mockCurrentChannelId.value = "channel_2"
    mockedUseChannelMessageFeed.mockClear()
    mockOpenerGate.mockClear()
    renderer.rerender(node())
    expect(screen.getByTestId("community-thread-split-parent")).toBe(parent)
    expect(screen.getByTestId("parent-draft")).toBe(draft)
    expect(draft.value).toBe("Parent draft")
    expect(scroll.scrollTop).toBe(120)
    expect(screen.getByTestId("community-thread-split-panel").querySelector("[data-message-list-skeleton]")).not.toBeNull()
    expect(renderer.container.querySelector('[data-channel-id="channel_1"]')).toBeNull()
    expect(mockOpenerGate).not.toHaveBeenCalled()
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    mockNavigation.pendingHref = "/c/channels/server_1/channel_3?msg=mC&inboxThreadOpener=nonceC"
    mockCurrentChannelId.value = "channel_3"
    renderer.rerender(node())
    expect(screen.getByTestId("parent-draft")).toBe(draft)
    configureThreadRoute()
    mockRouteModel.currentChannelMeta!.id = "channel_3"
    Object.assign(mockRouteModel, { routeHydrated: true, routeLifecycle: "ready" })
    renderer.rerender(node())
    expect(mockOpenerGate).toHaveBeenLastCalledWith(expect.objectContaining({ childChannelId: "channel_3", lifecycle: "pending" }))
    expect(mockedUseChannelMessageFeed).toHaveBeenLastCalledWith(expect.objectContaining({channelId: "channel_3", anchorMessageId: "mC"}))
    mockOpenerGate.mockClear()
    mockPathname.value = "/c/channels/server_1/channel_3"
    mockSearchParams.value = "msg=mC&inboxThreadOpener=nonceC"
    renderer.rerender(node())
    expect(renderer.container.firstElementChild).toBe(outer)
    expect(screen.getByTestId("community-thread-split-parent")).toBe(parent)
    expect(mockSplitContainerRef).toHaveBeenCalledTimes(1)
    expect(mockedUseChannelMessageFeed).toHaveBeenLastCalledWith(expect.objectContaining({
      channelId: "channel_3", anchorMessageId: "mC",
    }))
    expect(mockOpenerGate).toHaveBeenCalledExactlyOnceWith({
      serverId: "server_1", childChannelId: "channel_3", parentChannelId: "parent_1",
      openerMessageId: "opener_1", lifecycle: "ready",
    })
    expect(mockRouter.replace).not.toHaveBeenCalledWith(expect.stringContaining("mA"), expect.anything())
    renderer.unmount()
  })

  it("retires a cancelled target and consumes each Back/Forward child and query together", () => {
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockSearchParams.value = "msg=mA&inboxThreadOpener=nonceA"
    mockedUseChannelMessageFeed.mockReturnValue(feed({ anchorInCache: true }))
    mockSplitParentSurface.mockImplementation((props) => { useMockParentIdentity(props); return React.createElement("input", {
      "data-testid": "parent-draft", defaultValue: "",
    }) })
    const node = () => React.createElement(ServerLayout, null)
    const renderer = render(node())
    const draft = screen.getByTestId("parent-draft") as HTMLInputElement
    draft.value = "Retained parent draft"
    mockNavigation.navigationPending = true
    mockNavigation.pendingHref = "/c/channels/server_1/channel_2?msg=cancelled&inboxThreadOpener=cancelled"
    mockCurrentChannelId.value = "channel_2"
    mockRouteModel.currentChannelMeta!.id = "channel_2"
    mockedUseChannelMessageFeed.mockClear()
    mockOpenerGate.mockClear()
    renderer.rerender(node())
    expect(mockedUseChannelMessageFeed).toHaveBeenLastCalledWith(expect.objectContaining({channelId: "channel_2", anchorMessageId: "cancelled"}))
    expect(mockOpenerGate).toHaveBeenLastCalledWith(expect.objectContaining({childChannelId: "channel_2", lifecycle: "pending"}))
    expect(mockRouter.replace).not.toHaveBeenCalledWith(expect.stringContaining("cancelled"), expect.anything())
    mockedUseChannelMessageFeed.mockClear()
    mockNavigation.navigationPending = false
    mockNavigation.pendingHref = null
    mockCurrentChannelId.value = "channel_1"
    mockRouteModel.currentChannelMeta!.id = "channel_1"
    renderer.rerender(node())
    expect(mockedUseChannelMessageFeed).toHaveBeenLastCalledWith(expect.objectContaining({
      channelId: "channel_1", anchorMessageId: "mA",
    }))
    for (const [child, anchor] of [["channel_2", "forward"], ["channel_1", "back"]]) {
      mockPathname.value = `/c/channels/server_1/${child}`
      mockSearchParams.value = `msg=${anchor}&inboxThreadOpener=${anchor}`
      mockCurrentChannelId.value = child
      mockRouteModel.currentChannelMeta!.id = child
      renderer.rerender(node())
      expect(mockedUseChannelMessageFeed).toHaveBeenLastCalledWith(expect.objectContaining({
        channelId: child, anchorMessageId: anchor,
      }))
      expect(screen.getByTestId("parent-draft")).toBe(draft)
      expect(draft.value).toBe("Retained parent draft")
      expect(mockOpenerGate).toHaveBeenLastCalledWith(expect.objectContaining({ childChannelId: child }))
    }
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalledWith(expect.objectContaining({ anchorMessageId: "cancelled" }))
    renderer.unmount()
  })

  it.each(["parent", "server", "account"] as const)("retires the actual parent frame when the %s scope changes", (scope) => {
    configureThreadRoute()
    mockSearchParams.value = ""
    mockSplitMode.value = "split"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    mockSplitParentSurface.mockImplementation((props) => { useMockParentIdentity(props); return React.createElement("input", {
      "data-testid": "parent-draft", defaultValue: "",
    }) })
    const node = () => React.createElement(ServerLayout, null)
    const renderer = render(node())
    const draft = screen.getByTestId("parent-draft") as HTMLInputElement
    draft.value = "Old scope draft"
    if (scope === "parent") {
      mockRouteModel.layoutHint.parentChannelId = "parent_2"
      mockRouteModel.currentChannelMeta!.parentChannelId = "parent_2"
      mockRouteModel.server.categories = [{ channels: [{ id: "parent_2", name: "other", type: "text" }] }]
    } else if (scope === "server") {
      mockPathname.value = "/c/channels/server_2/channel_1"
      mockRouteModel.server.id = "server_2"
    } else mockViewerId.value = "viewer_2"
    renderer.rerender(node())
    const nextDraft = screen.getByTestId("parent-draft") as HTMLInputElement
    expect(nextDraft).not.toBe(draft)
    expect(draft.isConnected).toBe(false)
    expect(nextDraft.value).toBe("")
    renderer.unmount()
  })

  it("uses pending full and msg parameters without entering the old committed opener gate", () => {
    configureThreadRoute()
    mockSearchParams.value = "msg=old&inboxThreadOpener=old"
    mockSplitMode.value = "full"
    const renderer = render(React.createElement(ChannelRoute, {
      serverParam: "server_1", channelId: "channel_1",
      targetHref: "/c/channels/server_1/channel_1?threadView=full&msg=new&inboxThreadOpener=new",
      routeCommitted: false,
    }))
    expect(mockUseThreadSplitMode).toHaveBeenLastCalledWith({ breakpoint: "desktop", enabled: true, forceFullscreen: true })
    expect(mockOpenerGate).toHaveBeenLastCalledWith(expect.objectContaining({lifecycle: "pending"}))
    expect(mockedUseChannelMessageFeed).toHaveBeenLastCalledWith(expect.objectContaining({channelId: "channel_1", anchorMessageId: "new"}))
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
    expect(mockRouter.replace).not.toHaveBeenCalled()
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout", "full")
    renderer.unmount()
  })

  it("shows the cached split parent without admitting member/subscription effects before commit", async () => {
    await observeSecondary()
    const { ThreadSplitParentSurface } = await vi.importActual<typeof import("./thread-split-parent-surface")>("./thread-split-parent-surface")
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    mockSplitParentSurface.mockImplementation(props => React.createElement(ThreadSplitParentSurface, props as never))
    const node = (routeCommitted: boolean) => React.createElement(ChannelRoute, {serverParam: "server_1", channelId: "channel_1", routeCommitted})
    const renderer = render(node(false))
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({channelId: "parent_1"}))
    expect(mockClaimSecondary).not.toHaveBeenCalled()
    expect(mockedUseChannelMemberViewModel).toHaveBeenCalledWith(expect.objectContaining({channelId: "parent_1", accessAllowed: false}))
    expect(mockedUseChannelMemberViewModel).toHaveBeenCalledWith(expect.objectContaining({channelId: "parent_1", roleDisplayAllowed: true}))
    renderer.rerender(node(true))
    expect(mockClaimSecondary).toHaveBeenLastCalledWith(expect.anything(), expect.any(Symbol), "parent_1")
    expect(mockedUseChannelMemberViewModel).toHaveBeenCalledWith(expect.objectContaining({channelId: "parent_1", accessAllowed: true}))
    mockedUseChannelMemberViewModel.mockClear()
    renderer.rerender(node(false))
    expect(mockedUseChannelMemberViewModel).toHaveBeenCalledWith(expect.objectContaining({channelId: "parent_1", accessAllowed: false, roleDisplayAllowed: true}))
    mockedUseChannelMemberViewModel.mockClear()
    renderer.rerender(node(true))
    expect(mockedUseChannelMemberViewModel).toHaveBeenCalledWith(expect.objectContaining({channelId: "parent_1", accessAllowed: true, roleDisplayAllowed: true}))
  })

  it("lets the real parent surface read independently and retires it when its own proof is lost", async () => {
    await observeSecondary()
    const { ThreadSplitParentSurface } = await vi.importActual<typeof import("./thread-split-parent-surface")>("./thread-split-parent-surface")
    configureThreadRoute()
    Object.assign(mockRouteModel, { currentChannelMeta: null, routeHydrated: false, routeLifecycle: "pending" })
    mockSplitMode.value = "split"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    mockSplitParentSurface.mockImplementation((props) => React.createElement(ThreadSplitParentSurface, props as never))
    const node = () => React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" })
    const renderer = render(node())
    expect(mockUseChannelMetadata).toHaveBeenCalledWith("server_1", "parent_1")
    const [runtime, owner] = mockClaimSecondary.mock.calls.at(-1)!
    expect(mockClaimSecondary).toHaveBeenCalledWith(runtime, expect.any(Symbol), "parent_1")
    expect(mockedUseChannelMessageFeed).toHaveBeenLastCalledWith(expect.objectContaining({ channelId: "parent_1" }))
    expect(mockedUseChannelMessageFeed.mock.calls.every(([options]) => options.channelId === "parent_1")).toBe(true)
    expect(mockedUseChannelMemberViewModel).toHaveBeenCalledWith(expect.objectContaining({ channelId: "parent_1", accessAllowed: true }))
    mockedUseChannelMessageFeed.mockClear()
    mockedUseChannelMemberViewModel.mockClear()
    mockParentMetadata.canRead = false
    mockParentMetadata.status = "denied"
    renderer.rerender(node())
    expect(screen.getByTestId("community-thread-split-parent").querySelector("[data-message-list-skeleton]")).not.toBeNull()
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    expect(mockedUseChannelMemberViewModel).toHaveBeenCalledWith(expect.objectContaining({ channelId: "parent_1", accessAllowed: false }))
    expect(mockedUseChannelMemberViewModel).toHaveBeenCalledWith(expect.objectContaining({ channelId: "parent_1", roleDisplayAllowed: false }))
    expect(mockUseThreadSplitMode).toHaveBeenLastCalledWith({ breakpoint: "desktop", enabled: true, forceFullscreen: false })
    expect(mockReleaseSecondary).toHaveBeenLastCalledWith(runtime, owner)
    expect(screen.queryByLabelText("Resolving conversation")).not.toBeInTheDocument()
    mockParentMetadata.canRead = true
    mockParentMetadata.status = "readable"
    renderer.rerender(node())
    expect(mockClaimSecondary).toHaveBeenLastCalledWith(runtime, owner, "parent_1")
    mockUseChannelMetadata.mockClear()
    mockSplitMode.value = "full"
    renderer.rerender(node())
    expect(mockUseChannelMetadata).not.toHaveBeenCalled()
    expect(mockReleaseSecondary).toHaveBeenLastCalledWith(runtime, owner)
    expect(screen.queryByTestId("community-thread-split-parent")).not.toBeInTheDocument()
    renderer.unmount()
  })

  it("keeps the real parent owner for a same-parent child and replaces it only for a changed parent", async () => {
    await observeSecondary()
    const { ThreadSplitParentSurface } = await vi.importActual<typeof import("./thread-split-parent-surface")>("./thread-split-parent-surface")
    configureThreadRoute()
    Object.assign(mockRouteModel, { currentChannelMeta: null, routeHydrated: false, routeLifecycle: "pending" })
    mockSplitMode.value = "split"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    mockSplitParentSurface.mockImplementation((props) => React.createElement(ThreadSplitParentSurface, props as never))
    const renderer = render(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))
    const [runtime, owner] = mockClaimSecondary.mock.calls.at(-1)!
    renderer.rerender(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_2" }))
    expect(mockClaimSecondary).toHaveBeenCalledOnce()
    expect(mockReleaseSecondary).not.toHaveBeenCalled()
    mockRouteModel.server.categories = [{ channels: [{ id: "parent_2", name: "other", type: "text" }] }]
    mockRouteModel.layoutHint = { subtype: "thread", parentChannelId: "parent_2", parentSubtype: "text" }
    renderer.rerender(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_2" }))
    expect(mockReleaseSecondary).toHaveBeenCalledWith(runtime, owner)
    const [, nextOwner, parentId] = mockClaimSecondary.mock.calls.at(-1)!
    expect(nextOwner).not.toBe(owner)
    expect(parentId).toBe("parent_2")
    mockRouteModel.layoutHint = { subtype: "thread", parentChannelId: null, parentSubtype: "unknown" }
    renderer.rerender(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_2" }))
    expect(mockReleaseSecondary).toHaveBeenLastCalledWith(runtime, nextOwner)
    renderer.unmount()
  })

  it("keeps one cold loading target when mobile adopts its Drawer container", () => {
    configureThreadRoute()
    Object.assign(mockRouteModel, { currentChannelMeta: null, routeHydrated: false, routeLifecycle: "pending",
      layoutHint: { subtype: "thread", parentChannelId: null, parentSubtype: "unknown" } })
    mockBreakpoint.value = "unknown"
    mockSplitMode.value = "pending"
    const props = { serverParam: "server_1", channelId: "channel_1" }
    const renderer = render(React.createElement(ChannelRoute, props))
    const pane = screen.getByTestId("community-thread-split-panel")
    const skeleton = pane.querySelector("[data-message-list-skeleton]")
    expect(skeleton).not.toBeNull()
    expect(renderer.container.querySelector('[data-community-conversation-subtype="unknown"]')).toBeNull()
    mockRouteModel.layoutHint = { subtype: "thread", parentChannelId: "parent_1", parentSubtype: "text" }
    mockBreakpoint.value = "mobile"
    mockSplitMode.value = "full"
    renderer.rerender(React.createElement(ChannelRoute, props))
    const mobilePane = screen.getByTestId("community-thread-split-panel")
    expect(mobilePane.closest('[data-slot="mobile-page"]')).not.toBeNull()
    expect(mobilePane.querySelector("[data-message-list-skeleton]")).not.toBeNull()
    expect(screen.getAllByTestId("community-thread-split-panel")).toHaveLength(1)
    expect(mockUseChannelMetadata).not.toHaveBeenCalled()
    expect(mockClaimSecondary).not.toHaveBeenCalled()
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("keeps a qualified changed-parent child readable while its parent verifies independently", async () => {
    await observeSecondary()
    const { ThreadSplitParentSurface } = await vi.importActual<typeof import("./thread-split-parent-surface")>("./thread-split-parent-surface")
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    mockSplitParentSurface.mockImplementation((props) => React.createElement(ThreadSplitParentSurface, props as never))
    const renderer = render(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))
    const outer = renderer.container.firstElementChild
    const right = screen.getByTestId("community-thread-split-panel")
    mockRouteModel.server.categories = [{ channels: [{ id: "parent_2", name: "other", type: "text" }] }]
    mockRouteModel.currentChannelMeta!.id = "channel_2"
    mockRouteModel.currentChannelMeta!.parentChannelId = "parent_2"
    mockRouteModel.layoutHint = { subtype: "thread", parentChannelId: "parent_2", parentSubtype: "text" }
    mockCurrentChannelId.value = "channel_2"
    Object.assign(mockParentMetadata, { identityKnown: false, canRead: false, status: "pending" })
    mockedUseChannelMessageFeed.mockClear()
    renderer.rerender(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_2" }))
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout", "split")
    expect(screen.queryByLabelText("Resolving conversation")).not.toBeInTheDocument()
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({ channelId: "channel_2" }))
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalledWith(expect.objectContaining({ channelId: "parent_2" }))
    expect(mockUseChannelMetadata).toHaveBeenLastCalledWith("server_1", "parent_2")
    mockParentMetadata.identityKnown = true
    renderer.rerender(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_2" }))
    expect(renderer.container.firstElementChild).toBe(outer)
    expect(screen.getByTestId("community-thread-split-panel")).toBe(right)
    expect(screen.queryByLabelText("Resolving conversation")).not.toBeInTheDocument()
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout", "split")
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({ channelId: "channel_2" }))
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalledWith(expect.objectContaining({ channelId: "parent_2" }))
    renderer.unmount()
  })

  it.each(["pending", "denied"])("never claims an initially %s parent", async (status) => {
    await observeSecondary()
    const { ThreadSplitParentSurface } = await vi.importActual<typeof import("./thread-split-parent-surface")>("./thread-split-parent-surface")
    configureThreadRoute()
    Object.assign(mockRouteModel, { currentChannelMeta: null, routeHydrated: false, routeLifecycle: "pending" })
    Object.assign(mockParentMetadata, { canRead: false, status })
    mockSplitMode.value = "split"
    mockSplitParentSurface.mockImplementation((props) => React.createElement(ThreadSplitParentSurface, props as never))
    const renderer = render(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))
    expect(mockClaimSecondary).not.toHaveBeenCalled()
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    expect(mockedUseChannelMemberViewModel).toHaveBeenCalledWith(expect.objectContaining({ channelId: "parent_1", accessAllowed: false }))
    renderer.unmount()
  })

  it.each(["server", "account"] as const)("releases the real parent owner on %s scope change and unmount", async (scope) => {
    await observeSecondary()
    const { ThreadSplitParentSurface } = await vi.importActual<typeof import("./thread-split-parent-surface")>("./thread-split-parent-surface")
    configureThreadRoute()
    Object.assign(mockRouteModel, { currentChannelMeta: null, routeHydrated: false, routeLifecycle: "pending" })
    mockSplitMode.value = "split"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    mockSplitParentSurface.mockImplementation((props) => React.createElement(ThreadSplitParentSurface, props as never))
    const renderer = render(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))
    const [runtime, owner] = mockClaimSecondary.mock.calls.at(-1)!
    if (scope === "server") mockRouteModel.server.id = "server_2"
    else mockViewerId.value = "viewer_2"
    renderer.rerender(React.createElement(ChannelRoute, { serverParam: mockRouteModel.server.id, channelId: "channel_1" }))
    expect(mockReleaseSecondary).toHaveBeenCalledWith(runtime, owner)
    const [, nextOwner] = mockClaimSecondary.mock.calls.at(-1)!
    expect(nextOwner).not.toBe(owner)
    renderer.unmount()
    expect(mockReleaseSecondary).toHaveBeenLastCalledWith(runtime, nextOwner)
  })

  it("does not load a mobile parent underlay or keep its owner through narrow desktop", async () => {
    await observeSecondary()
    const { ThreadSplitParentSurface } = await vi.importActual<typeof import("./thread-split-parent-surface")>("./thread-split-parent-surface")
    mockSplitParentSurface.mockImplementation((props) => React.createElement(ThreadSplitParentSurface, props as never))
    configureThreadRoute()
    mockBreakpoint.value = "mobile"
    mockSplitMode.value = "full"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    const node = () => React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" })
    const renderer = render(node())
    for (const breakpoint of ["mobile", "desktop", "mobile"] as const) {
      mockBreakpoint.value = breakpoint
      renderer.rerender(node())
      expect(screen.queryByTestId("community-thread-split-parent")).not.toBeInTheDocument()
      expect(mockUseChannelMetadata).not.toHaveBeenCalled()
      expect(mockClaimSecondary).not.toHaveBeenCalled()
    }
    mockBreakpoint.value = "desktop"
    mockSplitMode.value = "split"
    renderer.rerender(node())
    expect(screen.getByTestId("community-thread-split-parent")).toBeInTheDocument()
    const [runtime, owner] = mockClaimSecondary.mock.calls.at(-1)!
    mockBreakpoint.value = "mobile"
    mockSplitMode.value = "full"
    renderer.rerender(node())
    expect(screen.queryByTestId("community-thread-split-parent")).not.toBeInTheDocument()
    expect(mockReleaseSecondary).toHaveBeenCalledWith(runtime, owner)
    renderer.unmount()
  })

  it("starts no transient parent resources through measured mobile639 to desktop640 transitions", async () => {
    await observeSecondary()
    const { ThreadSplitParentSurface } = await vi.importActual<typeof import("./thread-split-parent-surface")>("./thread-split-parent-surface")
    const { useThreadSplitMode } = await vi.importActual<typeof import("@/hooks/community/use-thread-split-mode")>("@/hooks/community/use-thread-split-mode")
    const modes: string[] = []
    mockUseThreadSplitMode.mockImplementation(function useMeasuredMode(options) {
      const result = useThreadSplitMode(options)
      modes.push(result.mode)
      return result
    })
    let width = 639
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width, height: 800, top: 0, right: width, bottom: 800, left: 0, x: 0, y: 0, toJSON: () => ({}),
    }))
    vi.stubGlobal("ResizeObserver", undefined)
    mockSplitParentSurface.mockImplementation((props) => React.createElement(ThreadSplitParentSurface, props as never))
    configureThreadRoute()
    mockBreakpoint.value = "mobile"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    const node = () => React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" })
    const renderer = render(node())
    const outer = renderer.container.firstElementChild
    const panel = screen.getByTestId("community-thread-split-panel")
    const header = panel.querySelector('[data-header-kind="thread"]')
    const composer = panel.querySelector<HTMLTextAreaElement>('[data-draft-key="server_1/channel_1"]')!
    expect(header).not.toBeNull()
    expect(composer).not.toBeNull()
    fireEvent.change(composer, { target: { value: "Keep this draft" } })
    for (const breakpoint of ["desktop", "mobile", "desktop"] as const) {
      mockBreakpoint.value = breakpoint
      width = breakpoint === "desktop" ? 640 : 639
      renderer.rerender(node())
      expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout", "full")
      expect(screen.queryByTestId("community-thread-split-parent")).not.toBeInTheDocument()
      expect({
        parentRenders: mockSplitParentSurface.mock.calls.length,
        metadataReads: mockUseChannelMetadata.mock.calls.length,
        secondaryClaims: mockClaimSecondary.mock.calls.length,
        parentFeeds: mockedUseChannelMessageFeed.mock.calls.filter(([options]) => options.channelId === "parent_1").length,
      }).toEqual({ parentRenders: 0, metadataReads: 0, secondaryClaims: 0, parentFeeds: 0 })
      expect(renderer.container.firstElementChild).toBe(outer)
      expect(screen.getByTestId("community-thread-split-panel")).toBe(panel)
      expect(panel.querySelector('[data-header-kind="thread"]')).toBe(header)
      expect(panel.querySelector('[data-draft-key="server_1/channel_1"]')).toBe(composer)
      expect(composer).toHaveValue("Keep this draft")
    }
    expect(modes).toContain("pending")
    width = 880
    act(() => window.dispatchEvent(new Event("resize")))
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout", "split")
    expect(mockUseChannelMetadata).toHaveBeenCalled()
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({ channelId: "parent_1" }))
    const [runtime, owner] = mockClaimSecondary.mock.calls.at(-1)!
    expect(owner).toBeDefined()
    mockBreakpoint.value = "mobile"
    width = 639
    renderer.rerender(node())
    expect(screen.queryByTestId("community-thread-split-parent")).not.toBeInTheDocument()
    expect(mockReleaseSecondary).toHaveBeenCalledWith(runtime, owner)
    expect(panel.querySelector('[data-header-kind="thread"]')).toBe(header)
    expect(panel.querySelector('[data-draft-key="server_1/channel_1"]')).toBe(composer)
    expect(composer).toHaveValue("Keep this draft")
    renderer.unmount()
  })

  it.each(["full", "non-thread"] as const)("starts no parent resources for a ready %s target", (kind) => {
    configureThreadRoute()
    mockSplitMode.value = "full"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    if (kind === "full") mockSearchParams.value = "threadView=full"
    if (kind === "non-thread") Object.assign(mockRouteModel, {
      isChild: false, currentChannelMeta: null, skeletonSubtype: "text",
      channel: { id: "channel_1", name: "general", type: "text" },
      layoutHint: { subtype: "text", parentChannelId: null, parentSubtype: "unknown" },
    })
    const renderer = render(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))
    expect(mockUseChannelMetadata).not.toHaveBeenCalled()
    expect(mockClaimSecondary).not.toHaveBeenCalled()
    expect(mockSplitParentSurface).not.toHaveBeenCalled()
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({ channelId: "channel_1" }))
    expect(renderer.container.querySelector('[data-community-conversation-subtype="unknown"]')).toBeNull()
    renderer.unmount()
  })

  it.each([
    ["pending", true],
    ["ready", false],
  ] as const)("keeps %s metadata on its known forum skeleton while access=%s", async (routeLifecycle, accessAllowed) => {
    Object.assign(mockRouteModel, {
      channel: { id: "channel_1", name: "cached-forum", type: "forum" },
      isForum: true,
      routeLifecycle,
      skeletonSubtype: "forum",
    })
    mockRouteModel.routeHydrated = accessAllowed
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    let renderer!: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })

    expect(renderer.container.querySelector(
      '[data-community-conversation-subtype="forum"]',
    )).not.toBeNull()
    expect(screen.getByTestId("forum-view-skeleton")).not.toBeNull()
    expect(mockedForumChannelSurface).not.toHaveBeenCalled()
    expect(mockedMessageList).not.toHaveBeenCalled()
  })

  it("uses a structural forum hint for skeleton shape without mounting or remembering content", () => {
    Object.assign(mockRouteModel, {
      server: null,
      channel: null,
      parent: null,
      currentChannelMeta: null,
      isForum: false,
      isChild: false,
      isForumPostChild: false,
      routeHydrated: false,
      routeLifecycle: "pending",
      skeletonSubtype: "forum",
    })
    mockRouteModel.routeHydrated = false
    mockCurrentChannelId.value = null

    render(React.createElement(ChannelRoute, {
      serverParam: "server_1",
      channelId: "channel_1",
    }))

    expect(screen.getByTestId("channel-header-skeleton").getAttribute("data-kind")).toBe("forum")
    expect(screen.getByTestId("forum-view-skeleton")).not.toBeNull()
    expect(screen.getByTestId("forum-view-skeleton").closest(
      '[data-community-conversation-subtype="forum"]',
    )).not.toBeNull()
    expect(mockedForumChannelSurface).not.toHaveBeenCalled()
    expect(mockedMessageList).not.toHaveBeenCalled()
    expect(mockSetLastChannel).not.toHaveBeenCalled()
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
  })

  it("uses a structural text hint without mounting the live MessageList", () => {
    Object.assign(mockRouteModel, {
      server: null,
      channel: null,
      parent: null,
      currentChannelMeta: null,
      isForum: false,
      isChild: false,
      isForumPostChild: false,
      routeHydrated: false,
      routeLifecycle: "pending",
      skeletonSubtype: "text",
    })
    mockRouteModel.routeHydrated = false
    mockCurrentChannelId.value = null

    const renderer = render(React.createElement(ChannelRoute, {
      serverParam: "server_1",
      channelId: "channel_1",
    }))

    expect(renderer.container.querySelector("[data-message-list-skeleton]")).not.toBeNull()
    expect(renderer.container.querySelector(
      '[data-community-conversation-subtype="text"]',
    )).not.toBeNull()
    expect(mockedMessageList).not.toHaveBeenCalled()
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
  })

  it("keeps eligible unknown-parent resolution neutral while the target retains its own typed slot", () => {
    mockSplitParentSurface.mockImplementation(() => null)
    Object.assign(mockRouteModel, {
      server: null, channel: null, parent: null, currentChannelMeta: null,
      routeLifecycle: "pending", routeHydrated: false, skeletonSubtype: "thread",
      layoutHint: { subtype: "thread", parentChannelId: "forum_1", parentSubtype: "forum" },
    })
    mockSplitMode.value = "split"
    mockRouteModel.routeHydrated = false
    mockCurrentChannelId.value = null
    render(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout", "pending")
    expect(screen.getByLabelText("Resolving conversation")).toBeInTheDocument()
    expect(screen.queryByTestId("forum-view-skeleton")).not.toBeInTheDocument()
    expect(screen.getByTestId("community-thread-split-panel").querySelector("[data-message-list-skeleton]")).not.toBeNull()
    expect(mockUseThreadSplitMode).toHaveBeenLastCalledWith({ breakpoint: "desktop", enabled: true, forceFullscreen: false })
    expect(mockSplitParentSurface).toHaveBeenCalledWith(expect.objectContaining({ channel: expect.objectContaining({ id: "forum_1" }) }), undefined)
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
    expect(mockDismissConversation).toHaveBeenLastCalledWith("viewer_1", {
      kind: "server", serverId: "server_1", channelId: "channel_1",
    }, false)
  })

  it.each(["unknown", "desktop"] as const)("prepares split actions before geometry resolves with breakpoint %s", (breakpoint) => {
    configureThreadRoute()
    mockBreakpoint.value = breakpoint
    mockSplitMode.value = "pending"
    const props = { serverParam: "server_1", channelId: "channel_1" }
    const renderer = render(React.createElement(ChannelRoute, props))
    const panel = screen.getByTestId("community-thread-split-panel")
    const fullscreen = screen.getByTestId("community-thread-split-fullscreen")
    const close = screen.getByTestId("community-thread-split-close")
    expect(mockHeaderParentNavigate.current).toBeTypeOf("function")
    mockBreakpoint.value = "desktop"
    mockSplitMode.value = "split"
    renderer.rerender(React.createElement(ChannelRoute, props))
    expect(screen.getByTestId("community-thread-split-panel")).toBe(panel)
    expect(screen.getByTestId("community-thread-split-fullscreen")).toBe(fullscreen)
    expect(screen.getByTestId("community-thread-split-close")).toBe(close)
    expect(mockHeaderParentNavigate.current).toBeUndefined()
    mockSplitMode.value = "full"
    renderer.rerender(React.createElement(ChannelRoute, props))
    expect(screen.queryByTestId("community-thread-split-fullscreen")).not.toBeInTheDocument()
    expect(mockHeaderParentNavigate.current).toBeTypeOf("function")
    renderer.unmount()
  })

  it("keeps readable target content independent of unresolved geometry and unknown parent type", () => {
    configureThreadRoute()
    mockSplitMode.value = "pending"
    const props = { serverParam: "server_1", channelId: "channel_1" }
    const renderer = render(React.createElement(ChannelRoute, props))
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout", "pending")
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout-pending", "true")
    const reservation = screen.getByTestId("community-thread-split-parent")
    expect(reservation).toBeEmptyDOMElement()
    expect(reservation).toHaveAttribute("inert")
    expect(mockSplitParentSurface).not.toHaveBeenCalled()
    expect(renderer.container.querySelector('[data-community-conversation-subtype="unknown"]')).toBeNull()
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({ channelId: "channel_1" }))
    Object.assign(mockRouteModel, {
      parent: null, currentChannelMeta: null, routeHydrated: false, routeLifecycle: "pending",
      skeletonSubtype: "thread",
      layoutHint: { subtype: "thread", parentChannelId: null, parentSubtype: "unknown" },
    })
    mockSplitMode.value = "split"
    renderer.rerender(React.createElement(ChannelRoute, props))
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout", "pending")
    expect(screen.getByLabelText("Resolving conversation")).toBeInTheDocument()
    expect(mockSplitParentSurface).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("keeps the measurement frame and split nodes while pending content becomes readable", () => {
    Object.assign(mockRouteModel, { channel: null, routeLifecycle: "pending", routeHydrated: false,
      skeletonSubtype: "thread",
      layoutHint: { subtype: "thread", parentChannelId: "parent_1", parentSubtype: "text" } })
    mockSplitMode.value = "pending"
    const props = { serverParam: "server_1", channelId: "channel_1" }
    const renderer = render(React.createElement(ChannelRoute, props))
    const outer = renderer.container.firstElementChild
    expect(outer?.tagName).toBe("DIV")
    const measurement = renderer.container.querySelector('[data-community-target-href]')
    expect(mockSplitContainerRef).toHaveBeenCalledWith(measurement)
    Object.assign(mockRouteModel, {
      skeletonSubtype: "thread",
      layoutHint: { subtype: "thread", parentChannelId: "parent_1", parentSubtype: "text" },
    })
    mockSplitMode.value = "split"
    renderer.rerender(React.createElement(ChannelRoute, props))
    const split = screen.getByTestId("community-thread-split")
    const parent = screen.getByTestId("community-thread-split-parent")
    const thread = screen.getByTestId("community-thread-split-panel")
    configureThreadRoute()
    Object.assign(mockRouteModel, { routeLifecycle: "ready", routeHydrated: true })
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    renderer.rerender(React.createElement(ChannelRoute, props))
    expect(renderer.container.firstElementChild).toBe(outer)
    expect(screen.getByTestId("community-thread-split")).toBe(split)
    expect(screen.getByTestId("community-thread-split-parent")).toBe(parent)
    expect(screen.getByTestId("community-thread-split-panel")).toBe(thread)
    expect(mockSplitContainerRef).toHaveBeenCalledTimes(1)
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledOnce()
    mockRouteModel.metadataError = true
    renderer.rerender(React.createElement(ChannelRoute, props))
    expect(renderer.container.firstElementChild).toBe(outer)
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible()
    renderer.unmount()
  })

  it("lets the qualified parent load while the forum opener still fences the child", () => {
    configureThreadRoute()
    mockRouteModel.isForumPostChild = true
    mockSplitMode.value = "split"
    mockForumOpener.isLoading = true
    const props = { serverParam: "server_1", channelId: "channel_1" }
    const renderer = render(React.createElement(ChannelRoute, props))
    const split = screen.getByTestId("community-thread-split")
    expect(mockSplitParentSurface).toHaveBeenLastCalledWith(expect.objectContaining({ channel: expect.objectContaining({ id: "parent_1" }) }), undefined)
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
    expect(screen.getByTestId("community-thread-split-panel").querySelector("[data-message-list-skeleton]")).not.toBeNull()
    Object.assign(mockForumOpener, { data: { content: "Post title" }, isLoading: false })
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    renderer.rerender(React.createElement(ChannelRoute, props))
    expect(screen.getByTestId("community-thread-split")).toBe(split)
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledOnce()
    expect(mockCommitLastCommunityRoute).toHaveBeenCalledOnce()
    renderer.unmount()
  })

  it("shows a required cold forum opener failure, keeps Retry feedback while pending, then opens body", async () => {
    configureThreadRoute()
    mockRouteModel.isForumPostChild = true
    Object.assign(mockForumOpener, { isError: true, error: new Error("deadline") })
    let release!: () => void
    mockForumOpener.refetch.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const props = { serverParam: "server_1", channelId: "channel_1" }
    const renderer = render(React.createElement(ChannelRoute, props))
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeDisabled()
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(mockForumOpener.refetch).toHaveBeenCalledOnce()
    Object.assign(mockForumOpener, { isError: false, error: null, isFetching: true, isLoading: true })
    renderer.rerender(React.createElement(ChannelRoute, props))
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled()
    await act(async () => { release() })
    Object.assign(mockForumOpener, { data: { content: "Recovered title" }, isFetching: false, isLoading: false })
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    renderer.rerender(React.createElement(ChannelRoute, props))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(mockedUseChannelMessageFeed).toHaveBeenCalled()
    renderer.unmount()
  })

  it("keeps a qualified target readable while the secondary server directory fails", () => {
    Object.assign(mockRouteModel, { server: null, serverError: true })
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    const renderer = render(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))
    expect(mockedUseChannelMessageFeed).toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
    renderer.unmount()
  })

  it("renders the terminal metadata error without opening a feed and forwards Retry", async () => {
    Object.assign(mockRouteModel, {
      isChild: true, routeLifecycle: "terminal-error", routeHydrated: false,
      metadataError: true, retryingMetadata: false,
    })
    let renderer!: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(ChannelRoute, {
        serverParam: "server_1", channelId: "channel_1",
      }))
    })
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeDisabled()
    expect(renderer.container.querySelector(
      '[data-community-conversation-subtype="unknown"]',
    )).toBeNull()
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(mockRouteModel.retryMetadata).toHaveBeenCalledTimes(1)
    Object.assign(mockRouteModel, { routeLifecycle: "pending", retryingMetadata: true })
    await act(async () => {
      renderer.rerender(React.createElement(ChannelRoute, {
        serverParam: "server_1", channelId: "channel_1",
      }))
    })
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled()
    await act(async () => renderer.unmount())
  })

  it.each(["desktop", "mobile"] as const)("keeps unknown %s route resolution outside the changing panel without hiding terminal Retry", breakpoint => {
    mockBreakpoint.value = breakpoint
    Object.assign(mockRouteModel, {
      server: null, channel: null, parent: null, currentChannelMeta: null,
      routeLifecycle: "pending", routeHydrated: false, skeletonSubtype: "unknown",
    })
    const node = () => React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" })
    const view = render(node())
    expect(vi.mocked(ThreadSplitView).mock.lastCall?.[0]).toMatchObject({ conversationSubtype: "unknown", resolvingParent: true })
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
    Object.assign(mockRouteModel, { routeLifecycle: "terminal-error", metadataError: true })
    view.rerender(node())
    expect(vi.mocked(ThreadSplitView).mock.lastCall?.[0]).toMatchObject({ conversationSubtype: "unknown", resolvingParent: false })
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(mockRouteModel.retryMetadata).toHaveBeenCalledTimes(1)
    Object.assign(mockRouteModel, { routeLifecycle: "pending", retryingMetadata: true })
    view.rerender(node())
    expect(vi.mocked(ThreadSplitView).mock.lastCall?.[0]).toMatchObject({ resolvingParent: false })
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled()
    view.unmount()
  })

  it("shows an authoritative split target before the effect-owned pointer commits", async () => {
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockCurrentChannelId.value = null
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    let renderer!: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })

    expect(screen.getByTestId("community-thread-split")).toHaveAttribute(
      "data-layout",
      "split",
    )
    expect(screen.getByTestId("community-thread-split-parent")).toBeInTheDocument()
    expect(screen.getByTestId("community-thread-split-panel")).toBeInTheDocument()
    expect(mockedUseChannelMessageFeed).toHaveBeenCalled()
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
    expect(mockDismissConversation).toHaveBeenLastCalledWith("viewer_1", expect.objectContaining({ channelId: "channel_1" }), false)
  })

  it("shows a qualified target while the previous pointer still fences client commit", () => {
    mockCurrentChannelId.value = "previous_channel"
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    const renderer = render(React.createElement(ChannelRoute, {
      serverParam: "server_1",
      channelId: "channel_1",
    }))

    expect(renderer.container.querySelector("[data-message-list-skeleton]")).toBeNull()
    expect(mockedUseChannelMessageFeed).toHaveBeenCalled()
    expect(mockSetLastChannel).not.toHaveBeenCalled()
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
  })

  it("keeps qualified content with a cleared pointer without re-committing route memory", () => {
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    const renderer = render(React.createElement(ChannelRoute, {
      serverParam: "server_1",
      channelId: "channel_1",
    }))
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledOnce()
    expect(mockCommitLastCommunityRoute).toHaveBeenCalledOnce()

    mockedUseChannelMessageFeed.mockClear()
    mockCommitLastCommunityRoute.mockClear()
    mockSetLastChannel.mockClear()
    mockCurrentChannelId.value = null
    act(() => {
      renderer.rerender(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })

    expect(renderer.container.querySelector("[data-message-list-skeleton]")).toBeNull()
    expect(mockedUseChannelMessageFeed).toHaveBeenCalled()
    expect(mockSetLastChannel).not.toHaveBeenCalled()
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
  })

  it("does not infer a target deletion from a secondary directory omission", () => {
    mockSearchParams.value = ""
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    const renderer = render(React.createElement(ChannelRoute, {
      serverParam: "server_1",
      channelId: "channel_1",
    }))

    Object.assign(mockRouteModel, {
      channel: null,
      isChild: true,
      routeHydrated: false,
      routeLifecycle: "pending",
      server: {
        ...mockRouteModel.server,
        categories: [{ channels: [{ id: "channel_2", name: "survivor", type: "text" }] }],
      },
    })
    mockDismissConversation.mockClear()
    act(() => {
      renderer.rerender(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })

    expect(mockClearLastChannel).not.toHaveBeenCalled()
    expect(mockRouter.replace).not.toHaveBeenCalled()
    expect(mockDismissConversation).toHaveBeenCalledWith(
      "viewer_1",
      { kind: "server", serverId: "server_1", channelId: "channel_1" },
      false,
    )
    expect(mockDismissConversation).not.toHaveBeenCalledWith(
      "viewer_1",
      { kind: "server", serverId: "server_1", channelId: "channel_1" },
      true,
    )
  })

  it("keeps server ejection when revocation removes the former top-level channel", () => {
    mockSearchParams.value = ""
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    let runtime!: ReturnType<typeof useCommunityRuntime>
    function Route() {
      const current = useCommunityRuntime()
      React.useLayoutEffect(() => { runtime = current }, [current])
      return React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" })
    }
    const renderer = render(React.createElement(Route))
    mockRouter.replace.mockClear()
    mockedUseChannelMessageFeed.mockClear()

    act(() => {
      runtime.ws.actions.revokeServerAccess("server_1")
      expect(runAuthoritativeServerEject({
        serverId: "server_1", servers: [], isSuccess: true, isFetching: false,
        consumeVoluntaryLeave: () => false, clearLastChannel: mockClearLastChannel,
        toast: vi.fn(), replace: mockRouter.replace,
      })).toBe(true)
      Object.assign(mockRouteModel, { server: null, channel: null, isChild: false,
        routeHydrated: false, routeLifecycle: "pending" })
      renderer.rerender(React.createElement(Route))
    })

    expect(mockRouter.replace).toHaveBeenCalledExactlyOnceWith("/c/me")
    expect(mockClearLastChannel).toHaveBeenCalledExactlyOnceWith("server_1")
    expect(mockedUseChannelMessageFeed).not.toHaveBeenCalled()
  })

  it("commits and dismisses only a ready top-level channel for the active account", async () => {
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    await act(async () => {
      render(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })
    expect(mockCommitLastCommunityRoute).toHaveBeenCalledWith(
      "viewer_1",
      "/c/channels/server_1/channel_1",
    )
    expect(mockDismissConversation).toHaveBeenCalledExactlyOnceWith(
      "viewer_1",
      { kind: "server", serverId: "server_1", channelId: "channel_1" },
      true,
    )
  })

  it.each([
    ["thread", () => configureThreadRoute()],
    ["forum", () => Object.assign(mockRouteModel, {
      channel: { id: "channel_1", name: "forum", type: "forum" },
      isForum: true,
    })],
  ] as const)("dismisses a ready %s surface with the exact viewer and target", (_surface, setup) => {
    setup()
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    render(React.createElement(ChannelRoute, {
      serverParam: "server_1",
      channelId: "channel_1",
    }))

    expect(mockDismissConversation).toHaveBeenCalledExactlyOnceWith(
      "viewer_1",
      { kind: "server", serverId: "server_1", channelId: "channel_1" },
      true,
    )
  })

  it.each([
    ["denied", () => { mockRouteModel.routeHydrated = false }],
    ["pending", () => {
      mockRouteModel.routeLifecycle = "pending"
      mockRouteModel.routeHydrated = false
    }],
    ["redirect", () => { mockCurrentChannelId.value = "previous_channel" }],
  ] as const)("does not dismiss while the server surface is %s", (_state, setup) => {
    setup()
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    render(React.createElement(ChannelRoute, {
      serverParam: "server_1",
      channelId: "channel_1",
    }))

    expect(mockDismissConversation).toHaveBeenCalledExactlyOnceWith(
      "viewer_1",
      { kind: "server", serverId: "server_1", channelId: "channel_1" },
      false,
    )
  })

  it.each([
    ["owner", true],
    ["admin", true],
    ["member", false],
  ] as const)("maps the %s role to the live text-channel Pin capability", async (role, allowed) => {
    mockMemberViewModel.myRole = role
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    await act(async () => {
      render(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })

    expect(mockCanManageServer).toHaveBeenCalledWith(role)
    const onPin = mockedMessageList.mock.calls.at(-1)?.[0].onPin
    if (allowed) expect(onPin).toEqual(expect.any(Function))
    else expect(onPin).toBeUndefined()
  })

  it("defers child msg cleanup until the handoff nonce has its own cleanup", async () => {
    mockSearchParams.value = "inboxThreadOpener=nonce-1&msg=m_target&keep=1"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    let renderer!: ReturnType<typeof render>
    await act(async () => {
      renderer = render(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })
    expect(mockRouter.replace).not.toHaveBeenCalled()

    mockSearchParams.value = "msg=m_target&keep=1"
    act(() => {
      renderer.rerender(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })
    expect(mockRouter.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1?keep=1",
      { scroll: false },
    )
  })

  it("composes a wide child route as parent + thread with fullscreen and close actions", async () => {
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockSearchParams.value = "keep=1"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    let renderer!: ReturnType<typeof render>

    await act(async () => {
      renderer = render(React.createElement(ChannelRoute, {
        serverParam: "server_1",
        channelId: "channel_1",
      }))
    })

    expect(screen.getByTestId("community-thread-split")).toHaveAttribute(
      "data-layout",
      "split",
    )
    expect(mockSplitParentSurface).toHaveBeenCalledWith(expect.objectContaining({
      channel: expect.objectContaining({ id: "parent_1", type: "text" }),
    }), undefined)

    fireEvent.click(screen.getByTestId("community-thread-split-fullscreen"))
    expect(mockUiHandlers.cancelPendingNavigation).toHaveBeenCalledOnce()
    expect(mockUiHandlers.cancelPendingNavigation.mock.invocationCallOrder[0])
      .toBeLessThan(mockNavigation.push.mock.invocationCallOrder[0]!)
    expect(mockNavigation.push).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1?keep=1&threadView=full",
      { scroll: false },
    )

    expect(mockRouter.push).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("community-thread-split-close"))
    expect(mockUiHandlers.goBackMobile).toHaveBeenCalledWith("/c/channels/server_1/parent_1")
  })

  it("uses the same split parent contract for a forum post", async () => {
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockRouteModel.parent = { id: "parent_1", name: "questions", type: "forum" }
    mockRouteModel.isForumPostChild = true
    mockRouteModel.server.categories = [{
      channels: [{ id: "parent_1", name: "questions", type: "forum" }],
    }]
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    await act(async () => {
      render(React.createElement(ChannelRoute, {
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
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it.each(["text", "thread"])("carries a Marked %s anchor through the existing navigation intent after URL cleanup", kind => {
    if (kind === "thread") configureThreadRoute()
    mockSearchParams.value = "keep=1"
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    const route = () => React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" })
    const renderer = render(route())
    for (const anchor of ["first-marked", "second-marked"]) {
      mockNavigation.entryIntent = { href: `/c/channels/server_1/channel_1?seq=7&msg=${anchor}` }
      renderer.rerender(route())
      expect(mockedUseChannelMessageFeed.mock.lastCall?.[0].anchorMessageId).toBe(anchor)
      renderer.rerender(route())
      expect(mockedUseChannelMessageFeed.mock.lastCall?.[0].anchorMessageId).toBe(anchor)
    }
    mockNavigation.entryIntent = { href: "/c/channels/server_1/channel_1" }
    renderer.rerender(route())
    expect(mockedUseChannelMessageFeed.mock.lastCall?.[0].anchorMessageId).toBeNull()
    expect(mockRouter.replace).not.toHaveBeenCalled()
  })

  it("renders a qualified server target before the client subscription effect while retaining client readiness fences", () => {
    mockCurrentChannelId.value = null
    const registry = renderCommunityHook(() => useOptionalCommunityDbRegistry()).result.current!
    renderToString(React.createElement(QueryClientProvider, { client: registry.queryClient },
      React.createElement(CommunityDbProvider, { registry }, React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))))
    expect(mockedMessageList).toHaveBeenCalled()
    expect(mockCommitLastCommunityRoute).not.toHaveBeenCalled()
    expect(mockDismissConversation).toHaveBeenLastCalledWith("viewer_1", { kind: "server", serverId: "server_1", channelId: "channel_1" }, false)
  })

  it("keeps the qualified child visible while the parent independently waits for permission", () => {
    configureThreadRoute()
    mockSplitMode.value = "split"
    mockParentMetadata.identityKnown = false
    mockParentMetadata.canRead = false
    mockParentMetadata.status = "pending"
    mockSplitParentSurface.mockImplementation(() => null)
    const view = render(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))
    expect(screen.getByTestId("community-thread-split")).toHaveAttribute("data-layout", "split")
    expect(view.container.querySelector('[aria-label="Resolving conversation"]')).toBeNull()
    expect(mockedUseChannelMessageFeed).toHaveBeenCalledWith(expect.objectContaining({ channelId: "channel_1" }))
    expect(mockParentMetadata.canRead).toBe(false)
    expect(mockClaimSecondary).not.toHaveBeenCalled()
  })

  it("keeps cold document metadata and body on the same explicit target after URL cleanup", async () => {
    const view = render(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))
    expect(vi.mocked(useChannelRouteModel).mock.lastCall?.[4]).toBe("m_target")
    mockSearchParams.value = "keep=1"
    view.rerender(React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }))
    expect(vi.mocked(useChannelRouteModel).mock.lastCall?.[4]).toBe("m_target")
    expect(mockedUseChannelMessageFeed.mock.lastCall?.[0].anchorMessageId).toBe("m_target")
  })

  it("keeps the route anchor until MessageList reports a successful jump", async () => {
    let surfaceFeed = feed({ messages: [{ id: "m_unrelated" }] })
    mockedUseChannelMessageFeed.mockImplementation(() => surfaceFeed)
    let renderer: ReturnType<typeof render>

    await act(async () => {
      renderer = render(
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
      renderer!.rerender(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })

    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")
    act(() => vi.advanceTimersByTime(5000))
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")
    act(() => mockedMessageList.mock.calls.at(-1)?.[0].onScrollTargetConsumed?.("m_target"))
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBeNull()
  })

  it("clears the route anchor only after the authoritative anchor request errors", async () => {
    let surfaceFeed = feed({ messages: [{ id: "m_unrelated" }] })
    mockedUseChannelMessageFeed.mockImplementation(() => surfaceFeed)
    let renderer: ReturnType<typeof render>

    await act(async () => {
      renderer = render(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })

    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")
    surfaceFeed = feed({ messages: [{ id: "m_unrelated" }], isError: true })
    act(() => {
      renderer!.rerender(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBeNull()
  })

  it("does not initialize an active message feed for a forum route", async () => {
    Object.assign(mockRouteModel, {
      channel: { id: "channel_1", name: "forum", type: "forum" },
      isForum: true,
    })
    mockedUseChannelMessageFeed.mockImplementation(() => feed())

    await act(async () => {
      render(
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

  it("initializes only the child feed for a thread route", async () => {
    configureThreadRoute()
    mockedUseChannelMessageFeed.mockImplementation(() => feed({ anchorInCache: true }))

    await act(async () => {
      render(
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

  it("requests the verified parent through the shared Back control", async () => {
    configureThreadRoute()
    mockBreakpoint.value = "mobile"
    mockedUseChannelMessageFeed.mockImplementation(() => feed({ anchorInCache: true }))

    await act(async () => {
      render(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    act(() => mockHeaderParentNavigate.current?.())

    expect(mockUiHandlers.goBackMobile).toHaveBeenCalledWith(
      "/c/channels/server_1/parent_1",
    )
    expect(mockUiHandlers.replacePath).not.toHaveBeenCalled()
  })

  it("requests the canonical server root through the shared Back control", async () => {
    mockBreakpoint.value = "mobile"
    mockedUseChannelMessageFeed.mockImplementation(() => feed())

    await act(async () => {
      render(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    act(() => mockHeaderServerNavigate.current?.())

    expect(mockUiHandlers.goBackMobile).toHaveBeenCalledWith(
      "/c/channels/server_1",
    )
    expect(mockUiHandlers.replacePath).not.toHaveBeenCalled()
  })

  it("keeps a child target through warm cache and 5000ms until MessageList consumes it", async () => {
    configureThreadRoute()
    let childFeed = feed({ messages: [{ id: "m_unrelated" }], anchorInCache: true })
    mockedUseChannelMessageFeed.mockImplementation(() => childFeed)
    let renderer: ReturnType<typeof render>

    await act(async () => {
      renderer = render(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })

    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")
    childFeed = feed({ messages: [{ id: "m_target" }], anchorInCache: true })
    act(() => {
      renderer!.rerender(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    act(() => vi.advanceTimersByTime(5000))
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")
    act(() => mockedMessageList.mock.calls.at(-1)?.[0].onScrollTargetConsumed?.("m_target"))
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBeNull()
  })

  it("clears a missing child target only after the child feed errors", async () => {
    configureThreadRoute()
    let childFeed = feed({ messages: [{ id: "m_unrelated" }], anchorInCache: true })
    mockedUseChannelMessageFeed.mockImplementation(() => childFeed)
    let renderer: ReturnType<typeof render>

    await act(async () => {
      renderer = render(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBe("m_target")

    childFeed = feed({ messages: [{ id: "m_unrelated" }], isError: true, anchorInCache: true })
    act(() => {
      renderer!.rerender(
        React.createElement(ChannelRoute, { serverParam: "server_1", channelId: "channel_1" }),
      )
    })
    expect(mockedMessageList.mock.calls.at(-1)?.[0].scrollToMessageId).toBeNull()
  })
})
