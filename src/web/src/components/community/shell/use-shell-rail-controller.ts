"use client"

import { useCallback, useMemo } from "react"
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
} from "@/hooks/community/mutations"
import { getLastChannel, pickServerLandingHref } from "@/lib/community/last-channel"
import { getLastMeLeaf, ME_ROOT, pickMeLandingLocation } from "@/lib/community/last-me-location"
import type { Breakpoint } from "@/hooks/use-mobile"
import { useCommunityStore } from "@/stores/community"
import { resolveServerRailOverlayAction } from "./server-rail-actions"
import type { ShellFrameProps } from "./shell-frame-types"
import type { View } from "./shell-types"
import type { CommunityNavigationController } from "./use-community-navigation-controller"
import type { QueryClient } from "@tanstack/react-query"

type Options = Pick<
  ShellFrameProps,
  | "view"
  | "activeServerId"
  | "onOpenActiveServerSettings"
  | "onOpenActiveServerInvite"
> & {
  navigation: CommunityNavigationController
  queryClient: QueryClient
  breakpoint: Breakpoint
  projectedView?: View
  projectedActiveServerId: string | undefined
}

export function useShellRailController({
  navigation,
  queryClient,
  breakpoint,
  view,
  projectedView = view,
  activeServerId,
  projectedActiveServerId,
  onOpenActiveServerSettings,
  onOpenActiveServerInvite,
}: Options) {
  const serversQuery = useServers()
  const { servers } = serversQuery
  const { folders } = useFolders()
  const currentServerId = useCommunityStore((state) => state.currentServerId)
  const { mutateAsync: createServerAsync } = useCreateServer()
  const { mutate: leaveServerMutate } = useLeaveServer()
  const { mutate: uploadServerIconMutate } = useUploadServerIcon()
  const railServers = useMemo(
    () => servers
      .map((server) => ({ ...server, active: server.id === projectedActiveServerId })),
    [projectedActiveServerId, servers],
  )

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
        queryFn: serverQueryFn(queryClient, id),
        staleTime: Infinity,
      })
    } catch {
      return root
    }
    return serverDestination(id)
  }, [queryClient, serverDestination])

  const onServerNavigate = useCallback((id: string) => {
    markSwitch("server", id)
    navigation.push(`/c/channels/${id}`)
  }, [navigation])
  const homeDestination = useCallback(
    () => breakpoint === "desktop"
      ? pickMeLandingLocation(getLastMeLeaf())
      : ME_ROOT,
    [breakpoint],
  )
  const onHome = useCallback(() => {
    navigation.push(homeDestination())
  }, [homeDestination, navigation])
  const onServerPrefetch = useCallback((id: string) => {
    void resolveServerDestination(id).then((destination) => navigation.prefetch(destination))
  }, [navigation, resolveServerDestination])
  const onHomePrefetch = useCallback(
    () => navigation.prefetch(homeDestination()),
    [homeDestination, navigation],
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
      navigation.push(`/c/channels/${newId}`)
    } catch (error) {
      toastApiError(error, "Failed to create server")
    }
  }, [createServerAsync, navigation, uploadServerIconMutate])
  const onLeaveServer = useCallback((id: string) => {
    markVoluntaryLeave(id)
    leaveServerMutate(
      { serverId: id },
      {
        onSuccess: () => {
          toast("Left server")
          if (currentServerId === id) {
            navigation.replace(pickPostEjectDestination(servers, id))
          }
        },
        onError: (error) => toastApiError(error, "Failed to leave server"),
      },
    )
  }, [currentServerId, leaveServerMutate, navigation, servers])
  const onOpenSettings = useCallback((id?: string) => {
    if (!id) return
    const action = resolveServerRailOverlayAction({
      targetServerId: id,
      activeServerId,
      overlay: "settings",
      hasActiveOpener: !!onOpenActiveServerSettings,
    })
    if (action.kind === "open-active") onOpenActiveServerSettings?.()
    else navigation.push(action.href)
  }, [activeServerId, navigation, onOpenActiveServerSettings])
  const onOpenInvitePopover = useCallback((id?: string) => {
    if (!id) return
    const action = resolveServerRailOverlayAction({
      targetServerId: id,
      activeServerId,
      overlay: "invite",
      hasActiveOpener: !!onOpenActiveServerInvite,
    })
    if (action.kind === "open-active") onOpenActiveServerInvite?.()
    else navigation.push(action.href)
  }, [activeServerId, navigation, onOpenActiveServerInvite])
  const navigate = useCallback((serverId: string, channelId?: string) => {
    markSwitch(channelId ? "channel" : "server", channelId ?? serverId)
    if (channelId) {
      navigation.push(`/c/channels/${serverId}/${channelId}`)
      return
    }
    navigation.push(serverDestination(serverId))
  }, [navigation, serverDestination])

  return {
    railProps: {
      servers: railServers,
      folders,
      activeServerId: projectedActiveServerId,
      serversLoading: serversQuery.isPending,
      view: projectedView,
      onHome,
      onHomePrefetch,
      onServerNavigate,
      onServerPrefetch,
      onCreateServer,
      onLeaveServer,
      onOpenSettings,
      onOpenInvitePopover,
    },
    navigate,
  }
}
