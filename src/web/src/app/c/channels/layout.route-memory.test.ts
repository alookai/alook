import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  cancelPendingNavigation: vi.fn(),
  runEject: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({ serverId: "missing-server", channelId: "missing-channel" }),
  usePathname: () => "/c/channels/missing-server/missing-channel",
  useRouter: () => ({ replace: mocks.replace, prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ toastApiError: vi.fn() }))
vi.mock("@/lib/perf/switch-mark", () => ({ markSwitch: vi.fn() }))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  DialogContent: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/components/community/channels/use-channel-tree", () => ({
  useChannelTree: () => [],
}))
vi.mock("@/components/community/shell/shell-frame", () => ({
  ShellFrame: ({ children }: { children: React.ReactNode }) => createElement("shell-frame", null, children),
}))
vi.mock("@/lib/community/community-route", () => ({
  channelHref: (serverId: string, channelId: string) => `/c/channels/${serverId}/${channelId}`,
  serverRootHref: (serverId: string) => `/c/channels/${serverId}`,
  serverModalMarkerCleanupHref: () => null,
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/components/community/channels/channel-sidebar", () => ({ ChannelSidebar: () => null }))
vi.mock("@/components/community/channels/channel-route", () => ({ ChannelRoute: () => null }))
vi.mock("@/components/community/settings/server-settings", () => ({ ServerSettings: () => null }))
vi.mock("@/components/community/image-crop-dialog", () => ({ ImageCropDialog: () => null }))
vi.mock("@/lib/community/image-crop", () => ({ validateIconSourceFile: () => ({ ok: true }) }))
vi.mock("@alook/shared", () => ({
  canManageServer: () => false,
  isForum: () => false,
  notifLevelDisplay: (value: string) => value,
}))
vi.mock("@/lib/community/profile-read", () => ({ readCommunityProfile: vi.fn() }))
vi.mock("@/stores/community", () => {
  const state = {
    setCurrentServerId: vi.fn(),
    uiHandlers: { cancelPendingNavigation: mocks.cancelPendingNavigation },
  }
  return {
    useCommunityStore: { getState: () => state },
    useCurrentChannelId: () => null,
    useCurrentChannelMeta: () => null,
  }
})
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer-1" }),
}))
vi.mock("@/hooks/community/use-servers", () => ({
  useServer: () => ({ server: undefined }),
  useServers: () => ({ servers: [], isSuccess: true, isFetching: false }),
}))
vi.mock("@/hooks/community/use-server-members", () => ({
  useServerMembers: () => ({
    members: [], loading: false, loadingMore: false, hasMore: false, total: 0,
    loadMore: vi.fn(), searchMembers: vi.fn(),
  }),
}))
vi.mock("@/lib/community/eject-server", () => ({
  consumeVoluntaryLeave: vi.fn(),
  runAuthoritativeServerEject: (args: Record<string, unknown>) => mocks.runEject(args),
}))
vi.mock("@/lib/community/last-channel", () => ({ clearLastChannel: vi.fn() }))
vi.mock("@/hooks/community/use-server-panels", () => ({ usePresence: vi.fn() }))
vi.mock("@/hooks/community/use-forum-sidebar-threads", () => ({
  resolveForumSidebarRouteCandidate: () => null,
  useForumSidebarThreads: () => ({ threads: [], parentUnread: {} }),
}))
vi.mock("@/stores/community/ws", () => ({
  useCommunityWsStore: (selector: (state: { profilesByUserId: Map<string, unknown> }) => unknown) =>
    selector({ profilesByUserId: new Map() }),
}))
vi.mock("@/hooks/community/use-notification-settings", () => ({
  resolveServerNotificationDisplayLevel: () => "default",
  useNotificationSettings: () => ({ server: {}, channel: {} }),
}))
vi.mock("@/hooks/community/mutations", () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn() })
  return {
    useCreateChannel: mutation,
    useRenameChannel: mutation,
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

describe("ServerLayout cold-entry ejection context", () => {
  beforeEach(() => {
    mocks.replace.mockClear()
    mocks.cancelPendingNavigation.mockClear()
    mocks.runEject.mockReset()
    mocks.runEject.mockImplementation((args: { replace: (destination: string) => void }) => {
      args.replace("/c/me/machines")
      return true
    })
  })

  it("passes authenticated account and exact leaf to the authoritative eject owner", () => {
    act(() => {
      TestRenderer.create(createElement(ServerLayout, null, createElement("child")))
    })

    expect(mocks.runEject).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "missing-server",
      accountId: "viewer-1",
      routeHref: "/c/channels/missing-server/missing-channel",
    }))
    expect(mocks.cancelPendingNavigation).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/machines")
  })
})
