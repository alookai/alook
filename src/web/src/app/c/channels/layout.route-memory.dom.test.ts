import { createElement, useLayoutEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  navigatePath: vi.fn(),
  cancelPendingNavigation: vi.fn(),
  setCurrentServerId: vi.fn(),
  toast: vi.fn(),
  toastApiError: vi.fn(),
  runEject: vi.fn(),
  deleteServer: vi.fn(),
  deleteServerAction: { current: null as null | (() => Promise<void>) },
  claimNavigation: vi.fn(),
  registerRoute: vi.fn(),
  routeProtected: { current: false },
  routeToken: {},
  clearLastChannel: vi.fn(),
  communityServerId: vi.fn(),
  useServer: vi.fn(),
  servers: { current: [] as Array<{ id: string }> },
  serverDetails: new Map<string, {
    categories: Array<{ channels: Array<{ id: string; pending?: boolean }> }>
  }>(),
  structuralSnapshot: { current: null as null | {
    servers: Array<{ id: string; channels: Array<{ id: string }> }>
  } },
  lastChannels: new Map<string, string>(),
  serverListSuccess: { current: true },
  serverListFetching: { current: false },
  serverAccessRevoked: { current: false },
  queryClient: { getQueryData: vi.fn(), fetchQuery: vi.fn() },
}))

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.queryClient,
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({ serverId: "missing-server", channelId: "missing-channel" }),
  usePathname: () => "/c/channels/missing-server/missing-channel",
  useRouter: () => ({ replace: mocks.replace, prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/api/client", () => ({ toastApiError: mocks.toastApiError }))
vi.mock("@/lib/perf/switch-mark", () => ({ markSwitch: vi.fn() }))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  DialogContent: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/components/community/channels/use-channel-tree", () => ({
  useChannelTree: () => [],
}))
vi.mock("@/components/community/shell/shell-frame", () => ({
  ShellFrame: ({ children, extraDialogs, ownerDeleteRouteScope }: {
    children: React.ReactNode
    extraDialogs?: React.ReactNode
    ownerDeleteRouteScope?: {
      serverId: string
      token: object
    }
  }) => {
    useLayoutEffect(() => {
      if (!ownerDeleteRouteScope) return
      mocks.registerRoute(
        ownerDeleteRouteScope.serverId,
        ownerDeleteRouteScope.token,
      )
    }, [ownerDeleteRouteScope])
    return createElement("shell-frame", null, children, extraDialogs)
  },
}))
vi.mock("@/lib/community/community-route", () => ({
  channelHref: (serverId: string, channelId: string) => `/c/channels/${serverId}/${channelId}`,
  communityServerId: (pathname: string) => mocks.communityServerId(pathname),
  serverRootHref: (serverId: string) => `/c/channels/${serverId}`,
  serverModalMarkerCleanupHref: () => null,
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/components/community/channels/channel-sidebar", () => ({ ChannelSidebar: () => null }))
vi.mock("@/components/community/channels/channel-route", () => ({ ChannelRoute: () => null }))
vi.mock("@/components/community/shell/community-pending-frame", () => ({
  CommunityPendingFrame: ({ href }: { href: string }) => createElement("div", {
    "data-testid": "owner-delete-pending-frame",
    "data-href": href,
  }),
}))
vi.mock("@/components/community/settings/server-settings", () => ({
  ServerSettings: ({ onDeleteServer }: { onDeleteServer: () => Promise<void> }) => {
    mocks.deleteServerAction.current = onDeleteServer
    return null
  },
}))
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
    setCurrentServerId: mocks.setCurrentServerId,
    uiHandlers: {
      cancelPendingNavigation: mocks.cancelPendingNavigation,
      navigatePath: mocks.navigatePath,
    },
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
  serverProjectedQueryFn: () => vi.fn(),
  useServer: (serverId: string | null) => {
    mocks.useServer(serverId)
    return { server: undefined }
  },
  useServers: () => ({
    servers: mocks.servers.current,
    isSuccess: mocks.serverListSuccess.current,
    isFetching: mocks.serverListFetching.current,
  }),
}))
vi.mock("@/hooks/community/use-structural-snapshot", () => ({
  useStructuralSnapshot: () => mocks.structuralSnapshot.current,
  structuralHintServer: () => null,
  hasStructuralServerTree: (server: { channels?: unknown[] } | null) => (
    (server?.channels?.length ?? 0) > 0
  ),
}))
vi.mock("@/hooks/community/use-server-members", () => ({
  useServerMembers: () => ({
    members: [], loading: false, loadingMore: false, hasMore: false, total: 0,
    loadMore: vi.fn(), searchMembers: vi.fn(),
  }),
}))
vi.mock("@/lib/community/eject-server", () => ({
  claimOwnerServerDeleteNavigation: (...args: unknown[]) => mocks.claimNavigation(...args),
  consumeVoluntaryLeave: vi.fn(),
  createOwnerServerDeleteRouteToken: () => mocks.routeToken,
  isOwnerServerDeleteCommittedRoute: () => true,
  isOwnerServerDeleteRouteProtected: () => mocks.routeProtected.current,
  pickPostEjectDestination: (
    servers: Array<{ id: string }>,
    deletedServerId: string,
    destination: (serverId: string) => string,
  ) => {
    const survivor = servers.find((server) => server.id !== deletedServerId)
    return survivor ? destination(survivor.id) : "/c/me"
  },
  registerOwnerServerDeleteRoute: (...args: unknown[]) => mocks.registerRoute(...args),
  runAuthoritativeServerEject: (args: Record<string, unknown>) => mocks.runEject(args),
}))
vi.mock("@/lib/community/last-channel", () => ({
  clearLastChannel: (...args: unknown[]) => mocks.clearLastChannel(...args),
  getLastChannel: (serverId: string) => mocks.lastChannels.get(serverId) ?? null,
  pickServerLandingHref: (serverId: string, channelIds: string[], last: string | null) => {
    const channelId = last ?? channelIds[0]
    return channelId
      ? `/c/channels/${serverId}/${channelId}`
      : `/c/channels/${serverId}`
  },
}))
vi.mock("@/hooks/community/use-server-panels", () => ({ usePresence: vi.fn() }))
vi.mock("@/hooks/community/use-forum-sidebar-threads", () => ({
  resolveForumSidebarRouteCandidate: () => null,
  useForumSidebarThreads: () => ({ threads: [], parentUnread: {} }),
}))
vi.mock("@/stores/community/ws", () => ({
  useCommunityWsStore: (selector: (state: {
    profilesByUserId: Map<string, unknown>
    revokedServerIds: Set<string>
  }) => unknown) => selector({
    profilesByUserId: new Map(),
    revokedServerIds: mocks.serverAccessRevoked.current
      ? new Set(["missing-server"])
      : new Set(),
  }),
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
    useDeleteServer: (callbacks: {
      routeToken: object
      onSuccess: (
        args: { serverId: string },
        result: { needsNavigation: boolean },
      ) => void
      onError: (error: Error, args: { serverId: string }) => void
    }) => ({
      mutate: (args: { serverId: string }) => {
        mocks.routeProtected.current = true
        mocks.deleteServer(args, {
          onSuccess: (needsNavigation = true) => {
            callbacks.onSuccess(args, { needsNavigation })
          },
          onError: (error: Error) => {
            mocks.routeProtected.current = false
            callbacks.onError(error, args)
          },
        })
      },
    }),
    useUpdateServer: mutation,
    useUploadServerIcon: mutation,
    useSetServerNotifLevel: mutation,
    useSetMemberRole: mutation,
    useKickMember: mutation,
    useRevokeInvite: mutation,
  }
})

import ServerLayout from "./layout"

describe("ServerLayout deletion routing", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/c/channels/missing-server/missing-channel")
    mocks.replace.mockClear()
    mocks.navigatePath.mockClear()
    mocks.cancelPendingNavigation.mockClear()
    mocks.setCurrentServerId.mockClear()
    mocks.toast.mockClear()
    mocks.toastApiError.mockClear()
    mocks.runEject.mockReset()
    mocks.deleteServer.mockReset()
    mocks.claimNavigation.mockReset()
    mocks.claimNavigation.mockReturnValue(true)
    mocks.registerRoute.mockReset()
    mocks.registerRoute.mockReturnValue("ordinary")
    mocks.routeProtected.current = false
    mocks.clearLastChannel.mockClear()
    mocks.communityServerId.mockReset()
    mocks.communityServerId.mockImplementation((pathname: string) => (
      pathname.match(/^\/c\/channels\/([^/?#]+)/)?.[1] ?? null
    ))
    mocks.deleteServerAction.current = null
    mocks.useServer.mockClear()
    mocks.servers.current = []
    mocks.serverDetails.clear()
    mocks.structuralSnapshot.current = null
    mocks.lastChannels.clear()
    mocks.serverListSuccess.current = true
    mocks.serverListFetching.current = false
    mocks.serverAccessRevoked.current = false
    mocks.queryClient.getQueryData.mockImplementation((key: unknown[]) => {
      if (key.length === 2 && key[1] === "servers") {
        return { servers: mocks.servers.current }
      }
      return mocks.serverDetails.get(String(key.at(-1)))
    })
    mocks.queryClient.fetchQuery.mockReset()
    mocks.queryClient.fetchQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => (
      Promise.resolve(mocks.serverDetails.get(String(queryKey.at(-1))))
    ))
    mocks.runEject.mockReturnValue(false)
  })

  it("checks the current pathname before running the generic eject", () => {
    expect(window.location.href).toContain("://")

    render(createElement(ServerLayout, null, createElement("div")))

    expect(mocks.communityServerId).toHaveBeenCalledWith(window.location.pathname)
    expect(mocks.communityServerId).not.toHaveBeenCalledWith(window.location.href)
    expect(mocks.runEject).toHaveBeenCalledOnce()
  })

  it("passes the authenticated leaf and target-specific revoke facts to generic eject", () => {
    mocks.serverListSuccess.current = false
    mocks.serverListFetching.current = true
    mocks.serverAccessRevoked.current = true
    mocks.runEject.mockImplementation((args: {
      replace: (destination: string) => void
    }) => {
      args.replace("/c/me/machines")
      return true
    })

    render(createElement(ServerLayout, null, createElement("div")))

    expect(mocks.runEject).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "missing-server",
      accountId: "viewer-1",
      routeHref: "/c/channels/missing-server/missing-channel",
      isSuccess: true,
      isFetching: false,
    }))
    expect(mocks.cancelPendingNavigation).toHaveBeenCalledTimes(1)
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/machines")
    expect(mocks.registerRoute).toHaveBeenCalledWith("missing-server", mocks.routeToken)
  })

  it("suppresses optimistic/list eject and replaces directly to the survivor Channel leaf", async () => {
    mocks.servers.current = [
      { id: "missing-server" },
      { id: "surviving-server" },
    ]
    mocks.serverDetails.set("surviving-server", {
      categories: [{ channels: [
        { id: "channel-default" },
        { id: "channel-remembered" },
      ] }],
    })
    mocks.lastChannels.set("surviving-server", "channel-remembered")
    mocks.runEject.mockImplementation((args: {
      ownerDeleteRouteProtected?: boolean
      servers: Array<{ id: string }>
    }) => !args.ownerDeleteRouteProtected
      && !args.servers.some((server) => server.id === "missing-server"))
    const rendered = render(createElement(ServerLayout, null, createElement("div")))

    await act(async () => mocks.deleteServerAction.current?.())
    const callbacks = mocks.deleteServer.mock.calls[0]![1] as {
      onSuccess: (needsNavigation?: boolean) => void
    }
    mocks.servers.current = [{ id: "surviving-server" }]
    rendered.rerender(createElement(ServerLayout, null, createElement("div")))
    expect(mocks.runEject).toHaveBeenLastCalledWith(expect.objectContaining({
      ownerDeleteRouteProtected: true,
    }))
    expect(mocks.useServer).toHaveBeenLastCalledWith(null)
    expect(rendered.getByTestId("owner-delete-pending-frame")).toBeInTheDocument()
    expect(mocks.replace).not.toHaveBeenCalled()

    await act(async () => callbacks.onSuccess())
    expect(mocks.claimNavigation).toHaveBeenCalledExactlyOnceWith(
      "missing-server",
      mocks.routeToken,
      "/c/channels/surviving-server/channel-remembered",
    )
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(
      "/c/channels/surviving-server/channel-remembered",
    )
    expect(mocks.navigatePath).not.toHaveBeenCalled()
    expect(mocks.setCurrentServerId).not.toHaveBeenCalledWith(null)
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("Server deleted")
  })

  it("replaces directly to /c/me when no Server survives", async () => {
    mocks.servers.current = [{ id: "missing-server" }]
    render(createElement(ServerLayout, null, createElement("div")))

    await act(async () => mocks.deleteServerAction.current?.())
    const callbacks = mocks.deleteServer.mock.calls[0]![1] as {
      onSuccess: (needsNavigation?: boolean) => void
    }
    mocks.servers.current = []
    await act(async () => callbacks.onSuccess())

    expect(mocks.claimNavigation).toHaveBeenCalledExactlyOnceWith(
      "missing-server",
      mocks.routeToken,
      "/c/me",
    )
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/me")
    expect(mocks.navigatePath).not.toHaveBeenCalled()
  })

  it("resolves a survivor leaf from the structural snapshot without waiting for a fetch", async () => {
    mocks.servers.current = [
      { id: "missing-server" },
      { id: "surviving-server" },
    ]
    mocks.structuralSnapshot.current = {
      servers: [{
        id: "surviving-server",
        channels: [{ id: "channel-structural" }],
      }],
    }
    render(createElement(ServerLayout, null, createElement("div")))

    await act(async () => mocks.deleteServerAction.current?.())
    const callbacks = mocks.deleteServer.mock.calls[0]![1] as {
      onSuccess: (needsNavigation?: boolean) => void
    }
    mocks.servers.current = [{ id: "surviving-server" }]
    await act(async () => callbacks.onSuccess())

    expect(mocks.queryClient.fetchQuery).not.toHaveBeenCalled()
    expect(mocks.claimNavigation).toHaveBeenCalledWith(
      "missing-server",
      mocks.routeToken,
      "/c/channels/surviving-server/channel-structural",
    )
  })

  it("keeps an already committed safe route without resolving or navigating", async () => {
    mocks.servers.current = [
      { id: "missing-server" },
      { id: "surviving-server" },
    ]
    render(createElement(ServerLayout, null, createElement("div")))

    await act(async () => mocks.deleteServerAction.current?.())
    const callbacks = mocks.deleteServer.mock.calls[0]![1] as {
      onSuccess: (needsNavigation?: boolean) => void
    }
    await act(async () => callbacks.onSuccess(false))

    expect(mocks.claimNavigation).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("Server deleted")
    expect(mocks.clearLastChannel).toHaveBeenCalledWith("missing-server")
  })

  it("drops a resolved target when the transaction claim loses to a safe commit", async () => {
    mocks.servers.current = [
      { id: "missing-server" },
      { id: "surviving-server" },
    ]
    mocks.serverDetails.set("surviving-server", {
      categories: [{ channels: [{ id: "channel-default" }] }],
    })
    mocks.claimNavigation.mockReturnValue(false)
    render(createElement(ServerLayout, null, createElement("div")))

    await act(async () => mocks.deleteServerAction.current?.())
    const callbacks = mocks.deleteServer.mock.calls[0]![1] as {
      onSuccess: (needsNavigation?: boolean) => void
    }
    await act(async () => callbacks.onSuccess())

    expect(mocks.claimNavigation).toHaveBeenCalledOnce()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("treats a deleted-Server route first committed after terminal cleanup as ordinary", () => {
    mocks.routeProtected.current = true
    mocks.registerRoute.mockImplementation(() => {
      mocks.routeProtected.current = false
      return "ordinary"
    })
    mocks.servers.current = [{ id: "surviving-server" }]
    mocks.runEject.mockImplementation((args: {
      ownerDeleteRouteProtected?: boolean
      replace: (destination: string) => void
    }) => {
      if (args.ownerDeleteRouteProtected) return false
      args.replace("/c/channels/surviving-server")
      return true
    })

    render(createElement(ServerLayout, null, createElement("div")))

    expect(mocks.registerRoute).toHaveBeenCalledWith("missing-server", mocks.routeToken)
    expect(mocks.runEject).toHaveBeenLastCalledWith(expect.objectContaining({
      ownerDeleteRouteProtected: false,
    }))
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(
      "/c/channels/surviving-server",
    )
  })

  it("clears a failed delete without navigation and restores ordinary eject eligibility", async () => {
    mocks.servers.current = [
      { id: "missing-server" },
      { id: "surviving-server" },
    ]
    mocks.runEject.mockImplementation((args: {
      ownerDeleteRouteProtected?: boolean
      servers: Array<{ id: string }>
      replace: (destination: string) => void
    }) => {
      if (args.ownerDeleteRouteProtected
        || args.servers.some((server) => server.id === "missing-server")) return false
      args.replace("/c/channels/surviving-server")
      return true
    })
    const rendered = render(createElement(ServerLayout, null, createElement("div")))

    await act(async () => mocks.deleteServerAction.current?.())
    const callbacks = mocks.deleteServer.mock.calls[0]![1] as {
      onError: (error: Error) => void
    }
    mocks.servers.current = [{ id: "surviving-server" }]
    rendered.rerender(createElement(ServerLayout, null, createElement("div")))
    expect(mocks.replace).not.toHaveBeenCalled()

    const error = new Error("delete failed")
    await act(async () => callbacks.onError(error))
    mocks.servers.current = [
      { id: "missing-server" },
      { id: "surviving-server" },
    ]
    rendered.rerender(createElement(ServerLayout, null, createElement("div")))
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.toastApiError).toHaveBeenCalledWith(error, "Failed to delete server")
    expect(mocks.useServer).toHaveBeenLastCalledWith("missing-server")

    mocks.servers.current = [{ id: "surviving-server" }]
    rendered.rerender(createElement(ServerLayout, null, createElement("div")))
    expect(mocks.runEject).toHaveBeenLastCalledWith(expect.objectContaining({
      ownerDeleteRouteProtected: false,
    }))
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(
      "/c/channels/surviving-server",
    )
  })
})
