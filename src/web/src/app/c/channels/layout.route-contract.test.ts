import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  navigatePath: vi.fn(),
  prefetch: vi.fn(),
  routeParams: { serverId: "server_1", channelId: "forum_1" as string | undefined },
  getLastChannel: vi.fn(() => "child_1" as string | null),
  clearLastChannel: vi.fn(),
  metaQuery: {
    data: undefined as undefined | Record<string, unknown>,
    error: null as unknown,
    isVerified: false,
  },
  sidebarProps: null as null | Record<string, unknown>,
  router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
  queryClient: { setQueryData: vi.fn() },
  store: {
    uiHandlers: {
      navigatePath: vi.fn(),
      cancelPendingNavigation: vi.fn(),
      openProfile: vi.fn(),
    },
    setCurrentServerId: vi.fn(),
    setCurrentChannelId: vi.fn(),
    setCurrentChannelMeta: vi.fn(),
  },
}))

vi.mock("next/navigation", () => ({
  useParams: () => mocks.routeParams,
  usePathname: () => "/c/channels/server_1/forum_1",
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks.queryClient }))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/components/ui/dialog", () => ({ Dialog: () => null, DialogContent: () => null }))
vi.mock("@/components/community/shell/shell-frame", () => ({
  ShellFrame: ({ sidebar, children }: { sidebar: () => React.ReactNode; children: React.ReactNode }) => (
    React.createElement(React.Fragment, null, sidebar(), children)
  ),
}))
vi.mock("@/components/community/channels/channel-sidebar", () => ({
  ChannelSidebar: (props: Record<string, unknown>) => {
    mocks.sidebarProps = props
    return null
  },
}))
vi.mock("@/components/community/channels/use-channel-tree", () => ({
  useChannelTree: () => ({ markRead: vi.fn() }),
}))
vi.mock("@/modules/community/client", () => ({ ChannelScreenSkeleton: () => null }))
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => null }))
vi.mock("@/components/community/settings/server-settings", () => ({ ServerSettings: () => null }))
vi.mock("@/components/community/image-crop-dialog", () => ({ ImageCropDialog: () => null }))
vi.mock("@/lib/community/image-crop", () => ({ validateIconSourceFile: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(), toastApiError: vi.fn() }))
vi.mock("@/lib/perf/switch-mark", () => ({ markSwitch: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/stores/community", () => {
  const useCommunityStore = Object.assign(
    (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
    { getState: () => mocks.store },
  )
  return {
    useCommunityStore,
    useCurrentChannelId: () => "child_1",
    useCurrentChannelMeta: () => ({ parentChannelId: "forum_1" }),
  }
})
vi.mock("@/stores/community/ws", () => ({
  useOnlineUserIds: () => new Set<string>(),
  useCommunityWsStore: Object.assign(
    (selector: (state: { userStatuses: Map<string, unknown> }) => unknown) =>
      selector({ userStatuses: new Map() }),
    { getState: () => ({ hydratePresence: vi.fn() }) },
  ),
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer_1" }),
}))
vi.mock("@/hooks/community/use-servers", () => ({
  useServer: () => ({
    server: {
      id: "server_1",
      name: "Server",
      icon: null,
      categories: [{
        id: "category_1",
        name: "Channels",
        channels: [{ id: "forum_1", name: "Forum", type: "forum" }],
      }],
    },
  }),
  useServers: () => ({
    servers: [{ id: "server_1" }],
    isSuccess: true,
    isFetching: false,
  }),
}))
vi.mock("@/hooks/community/use-server-members", () => ({
  useServerMembers: () => ({
    members: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    total: 0,
    loadMore: vi.fn(),
    searchMembers: vi.fn(),
  }),
}))
vi.mock("@/lib/community/eject-server", () => ({
  consumeVoluntaryLeave: vi.fn(),
  isDefinitiveChildMetaFailure: (error: unknown) => error !== null,
  runAuthoritativeServerEject: () => false,
}))
vi.mock("@/lib/community/last-channel", () => ({
  clearLastChannel: mocks.clearLastChannel,
  getLastChannel: mocks.getLastChannel,
  pickServerLandingChannel: (channelIds: readonly string[], last: string | null) =>
    last ?? channelIds[0],
}))
vi.mock("@/hooks/community/use-server-panels", () => ({
  usePresence: () => ({ online: [], isFetching: false, data: undefined }),
}))
vi.mock("@/hooks/community/use-forum-sidebar-threads", () => ({
  patchForumSidebarUnreadExact: vi.fn(),
  removeForumSidebarUnreadChild: vi.fn(),
  removeForumSidebarThreadExact: vi.fn(),
  resolveForumSidebarRouteCandidate: () => null,
  setForumSidebarParentUnreadBase: () => false,
  useForumSidebarThreads: () => ({
    threads: [{
      id: "child_1",
      parentChannelId: "forum_1",
      parentMessageId: "opener_1",
      title: "Child",
      unread: true,
    }],
    parentUnread: {},
  }),
}))
vi.mock("@/hooks/community/use-child-channel-meta", () => ({
  useChildChannelMeta: () => mocks.metaQuery,
}))
vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsSubscribe: vi.fn(),
  communityWsUnsubscribe: vi.fn(),
}))
vi.mock("@/hooks/community/use-notification-settings", () => ({
  resolveServerNotificationDisplayLevel: () => "all",
  useNotificationSettings: () => ({ server: {}, channel: {} }),
}))
vi.mock("@/lib/community/presence", () => ({ resolveRowPresence: () => "offline" }))
vi.mock("@/hooks/community/server-detail-cache", () => ({
  patchChannelUnread: (cache: unknown) => cache,
}))
vi.mock("@/lib/query-keys", () => ({
  communityKeys: { server: (id: string) => ["server", id] },
}))
vi.mock("@/hooks/community/mutations", () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn() })
  return {
    useCreateChannel: mutation,
    useDeleteChannel: mutation,
    useMoveChannel: mutation,
    useCreateCategory: mutation,
    useUpdateCategory: mutation,
    useDeleteCategory: mutation,
    useReorderCategories: mutation,
    useReorderChannels: mutation,
    useDeleteServer: mutation,
    useUpdateServer: mutation,
    useUploadServerIcon: mutation,
    useSetServerNotifLevel: mutation,
    useSetMemberRole: mutation,
    useKickMember: mutation,
    useRevokeInvite: mutation,
  }
})

import ServerLayout from "./layout"
import ServerDefaultPage from "./[serverId]/page"

describe("channels layout route contract", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sidebarProps = null
    mocks.routeParams = { serverId: "server_1", channelId: "forum_1" }
    mocks.metaQuery = { data: undefined, error: null, isVerified: false }
    mocks.getLastChannel.mockReturnValue("child_1")
    mocks.store.uiHandlers.navigatePath = mocks.navigatePath
    mocks.router.prefetch = mocks.prefetch
  })

  it("executes child selection and prefetch with one flat child id", () => {
    act(() => {
      TestRenderer.create(React.createElement(
        ServerLayout,
        null,
        React.createElement("div"),
      ))
    })
    const props = mocks.sidebarProps as {
      onSelectForumThread: (id: string) => void
      prefetchChannel: (id: string) => void
    }

    act(() => props.onSelectForumThread("child_1"))
    act(() => props.prefetchChannel("child_1"))

    expect(mocks.navigatePath).toHaveBeenCalledWith(
      "/c/channels/server_1/child_1",
    )
    expect(mocks.prefetch).toHaveBeenCalledWith(
      "/c/channels/server_1/child_1",
    )
  })

  it("executes top-level selection through the same flat builder", () => {
    act(() => {
      TestRenderer.create(React.createElement(ServerLayout, null))
    })
    const props = mocks.sidebarProps as { setActiveChannel: (id: string) => void }

    act(() => props.setActiveChannel("text_1"))

    expect(mocks.navigatePath).toHaveBeenCalledWith(
      "/c/channels/server_1/text_1",
    )
  })

  it("keeps the server root channel-less until its desktop landing redirect", () => {
    mocks.routeParams = { serverId: "server_1", channelId: undefined }
    act(() => {
      TestRenderer.create(React.createElement(ServerLayout, null))
    })
    expect(mocks.sidebarProps).not.toBeNull()
  })

  it("restores one remembered child id on the ordinary flat page", () => {
    mocks.routeParams = { serverId: "server_1", channelId: undefined }
    act(() => {
      TestRenderer.create(React.createElement(ServerDefaultPage))
    })
    expect(mocks.router.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/child_1",
    )
  })

})
