"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { markSwitch } from "@/lib/perf/switch-mark"
import { markVoluntaryLeave, pickPostEjectDestination } from "@/lib/community/eject-server"
import { serverQueryFn, useServers, type ServerDetail } from "@/hooks/community/use-servers"
import { useFolders } from "@/hooks/community/use-folders"
import {
  useCreateServer,
  useLeaveServer,
  useUploadServerIcon,
  useDeleteServerFolder,
  useReorderServers,
  useReorderFolders,
  useUpdateFolderItems,
  useCreateServerFolderWith,
} from "@/hooks/community/mutations"
import { getLastChannel, pickServerLandingHref } from "@/lib/community/last-channel"
import { getLastMeLeaf, pickMeLandingLocation } from "@/lib/community/last-me-location"
import {
  commitLatestNavigationIntent,
  createNavigationIntentGate,
  supersedeNavigationIntent,
} from "@/lib/community/navigation-intent"
import { useCommunityStore } from "@/stores/community"
import { resolveServerRailOverlayAction } from "./server-rail-actions"
import type { ShellFrameProps, ShellRouter } from "./shell-frame-types"
import type { QueryClient } from "@tanstack/react-query"

type Options = Pick<
  ShellFrameProps,
  | "view"
  | "activeServerId"
  | "setMobileZone"
  | "onOpenActiveServerSettings"
  | "onOpenActiveServerInvite"
  | "goHome"
  | "goServer"
> & {
  router: ShellRouter
  pathname: string
  queryClient: QueryClient
}

export function useShellRailController({
  router,
  pathname,
  queryClient,
  view,
  activeServerId,
  setMobileZone,
  onOpenActiveServerSettings,
  onOpenActiveServerInvite,
  goHome,
  goServer,
}: Options) {
  const serversQuery = useServers()
  const { servers } = serversQuery
  const { folders } = useFolders()
  const currentServerId = useCommunityStore((state) => state.currentServerId)
  const { mutateAsync: createServerAsync } = useCreateServer()
  const { mutate: leaveServerMutate } = useLeaveServer()
  const { mutate: uploadServerIconMutate } = useUploadServerIcon()
  const { mutate: deleteFolderMutate } = useDeleteServerFolder()
  const { mutate: reorderServersMutate } = useReorderServers()
  const { mutate: reorderFoldersMutate } = useReorderFolders()
  const { mutate: updateFolderItemsMutate } = useUpdateFolderItems()
  const { mutate: createFolderWithMutate } = useCreateServerFolderWith()

  const folderServerIds = useMemo(() => {
    const ids = new Set<string>()
    for (const folder of folders) for (const server of folder.servers) ids.add(server.id)
    return ids
  }, [folders])
  const railServers = useMemo(
    () => servers
      .filter((server) => !folderServerIds.has(server.id))
      .map((server) => ({ ...server, active: server.id === activeServerId })),
    [activeServerId, folderServerIds, servers],
  )

  const navigationGateRef = useRef(createNavigationIntentGate())
  const cancelPendingNavigation = useCallback(() => {
    supersedeNavigationIntent(navigationGateRef.current)
  }, [])
  useEffect(() => {
    cancelPendingNavigation()
  }, [cancelPendingNavigation, pathname])

  const serverDestination = useCallback((id: string) => {
    const detail = queryClient.getQueryData<ServerDetail>(communityKeys.server(id))
    const channelIds = detail?.categories.flatMap((category) =>
      category.channels.filter((channel) => !channel.pending).map((channel) => channel.id)
    ) ?? []
    return pickServerLandingHref(id, channelIds, getLastChannel(id))
  }, [queryClient])
  const resolveServerDestination = useCallback(async (id: string) => {
    const root = `/c/channels/${id}`
    const immediate = serverDestination(id)
    if (immediate !== root) return immediate
    try {
      await queryClient.fetchQuery({
        queryKey: communityKeys.server(id),
        queryFn: serverQueryFn(id),
        staleTime: Infinity,
      })
    } catch {
      return root
    }
    return serverDestination(id)
  }, [queryClient, serverDestination])

  const onServerNavigate = useCallback((id: string) => {
    markSwitch("server", id)
    void commitLatestNavigationIntent(
      navigationGateRef.current,
      () => resolveServerDestination(id),
      (destination) => router.push(destination),
    )
  }, [resolveServerDestination, router])
  const onHome = useCallback(() => {
    cancelPendingNavigation()
    goHome()
  }, [cancelPendingNavigation, goHome])
  const onServerPrefetch = useCallback((id: string) => {
    void resolveServerDestination(id).then((destination) => router.prefetch(destination))
  }, [resolveServerDestination, router])
  const onHomePrefetch = useCallback(
    () => router.prefetch(pickMeLandingLocation(getLastMeLeaf())),
    [router],
  )
  const onCreateServer = useCallback(async (name: string, icon?: File) => {
    try {
      const data = await createServerAsync({ name })
      const newId = data.server.id
      toast(`Server "${name}" created`)
      if (icon) {
        uploadServerIconMutate(
          { serverId: newId, file: icon },
          { onError: (error) => toastApiError(error, "Server created, but the icon failed to upload") },
        )
      }
      cancelPendingNavigation()
      router.push(`/c/channels/${newId}`)
    } catch (error) {
      toastApiError(error, "Failed to create server")
    }
  }, [cancelPendingNavigation, createServerAsync, router, uploadServerIconMutate])
  const onLeaveServer = useCallback((id: string) => {
    markVoluntaryLeave(id)
    leaveServerMutate(
      { serverId: id },
      {
        onSuccess: () => {
          toast("Left server")
          if (currentServerId === id) {
            cancelPendingNavigation()
            router.replace(pickPostEjectDestination(servers, id))
          }
        },
        onError: (error) => toastApiError(error, "Failed to leave server"),
      },
    )
  }, [cancelPendingNavigation, currentServerId, leaveServerMutate, router, servers])
  const onOpenSettings = useCallback((id?: string) => {
    if (!id) return
    cancelPendingNavigation()
    const action = resolveServerRailOverlayAction({
      targetServerId: id,
      activeServerId,
      overlay: "settings",
      hasActiveOpener: !!onOpenActiveServerSettings,
    })
    if (action.kind === "open-active") onOpenActiveServerSettings?.()
    else router.push(action.href)
  }, [activeServerId, cancelPendingNavigation, onOpenActiveServerSettings, router])
  const onOpenInvitePopover = useCallback((id?: string) => {
    if (!id) return
    cancelPendingNavigation()
    const action = resolveServerRailOverlayAction({
      targetServerId: id,
      activeServerId,
      overlay: "invite",
      hasActiveOpener: !!onOpenActiveServerInvite,
    })
    if (action.kind === "open-active") onOpenActiveServerInvite?.()
    else router.push(action.href)
  }, [activeServerId, cancelPendingNavigation, onOpenActiveServerInvite, router])
  const onUngroupFolder = useCallback((folderId: string) => {
    deleteFolderMutate(
      { folderId },
      { onSuccess: () => toast("Group removed"), onError: (error) => toastApiError(error, "Failed to remove group") },
    )
  }, [deleteFolderMutate])
  const onReorderRail = useCallback((serverIds: string[]) => {
    reorderServersMutate(
      { serverIds },
      { onError: (error) => toastApiError(error, "Failed to save server order") },
    )
  }, [reorderServersMutate])
  const onReorderFolders = useCallback((folderIds: string[]) => {
    reorderFoldersMutate(
      { folderIds },
      { onError: (error) => toastApiError(error, "Failed to reorder groups") },
    )
  }, [reorderFoldersMutate])
  const onFolderItemsChange = useCallback((folderId: string, serverIds: string[]) => {
    updateFolderItemsMutate(
      { folderId, serverIds },
      { onError: (error) => toastApiError(error, "Failed to update group") },
    )
  }, [updateFolderItemsMutate])
  const onDragCreateFolder = useCallback((serverIdA: string, serverIdB: string) => {
    createFolderWithMutate(
      { serverIdA, serverIdB },
      { onError: (error) => toastApiError(error, "Failed to create group") },
    )
  }, [createFolderWithMutate])

  const navigate = useCallback((serverId: string, channelId?: string) => {
    markSwitch(channelId ? "channel" : "server", channelId ?? serverId)
    if (channelId) {
      cancelPendingNavigation()
      router.push(`/c/channels/${serverId}/${channelId}`)
      return
    }
    void commitLatestNavigationIntent(
      navigationGateRef.current,
      () => resolveServerDestination(serverId),
      (destination) => router.push(destination),
    )
  }, [cancelPendingNavigation, resolveServerDestination, router])

  return {
    railProps: {
      servers: railServers,
      folders,
      activeServerId,
      serversLoading: serversQuery.isLoading,
      setMobileZone,
      view,
      onHome,
      onHomePrefetch,
      onServer: goServer,
      onServerNavigate,
      onServerPrefetch,
      onCreateServer,
      onLeaveServer,
      onOpenSettings,
      onOpenInvitePopover,
      onUngroupFolder,
      onReorderRail,
      onReorderFolders,
      onFolderItemsChange,
      onDragCreateFolder,
    },
    navigate,
    cancelPendingNavigation,
  }
}
