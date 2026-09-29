"use client"

import { useCallback, useMemo } from "react"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { markSwitch } from "@/lib/perf/switch-mark"
import { markVoluntaryLeave, pickPostEjectDestination } from "@/lib/community/eject-server"
import {
  useServers,
} from "@/hooks/community/use-servers"
import { useFolders } from "@/hooks/community/use-folders"
import {
  useCreateServer,
  useLeaveServer,
  useUploadServerIcon,
} from "@/hooks/community/mutations"
import {
  getLastChannel,
  pickServerLandingHref,
  serverLandingChannelIds,
} from "@/lib/community/last-channel"
import { getLastMeLeaf, ME_ROOT, pickMeLandingLocation } from "@/lib/community/last-me-location"
import type { Breakpoint } from "@/hooks/use-mobile"
import { useCommunityStore } from "@/stores/community"
import { resolveServerRailOverlayAction } from "./server-rail-actions"
import type { ShellFrameProps } from "./shell-frame-types"
import type { View } from "./shell-types"
import type { CommunityNavigationController } from "./use-community-navigation-controller"
import type { QueryClient } from "@tanstack/react-query"
import {
  readServerTreeProjection,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import {
  createServerDetailResourceQueryFn,
  serverDetailResourceChannelIds,
  serverDetailResourceKey,
  type ServerDetailResource,
} from "@/lib/community-db/server-detail-resource"

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
  accountId?: string
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
  accountId,
}: Options) {
  const communityDb = useOptionalCommunityDbRegistry()
  const serversQuery = useServers()
  const foldersQuery = useFolders()
  const servers = serversQuery.servers
  const folders = foldersQuery.folders
  const serverCollectionReadiness = communityDb?.getCollectionReadiness("servers")
  const serverCollectionPending = serverCollectionReadiness === "not-ready"
    || serverCollectionReadiness === "preloading"
  const hasLiveServers = servers.length > 0 || serversQuery.isSuccess || !accountId
  const currentServerId = useCommunityStore((state) => state.currentServerId)
  const { mutateAsync: createServerAsync } = useCreateServer()
  const { mutate: leaveServerMutate } = useLeaveServer()
  const { mutate: uploadServerIconMutate } = useUploadServerIcon()
  const railServers = useMemo(
    () => servers
      .map((server) => ({ ...server, active: server.id === projectedActiveServerId })),
    [projectedActiveServerId, servers],
  )

  const serverDestination = useCallback(async (id: string) => {
    const lastChannel = getLastChannel(id)
    const scopeId = communityDb?.scopeId ?? accountId
    const resourceKey = scopeId ? serverDetailResourceKey(scopeId, id) : null
    const detail = resourceKey
      ? queryClient.getQueryData<ServerDetailResource>(resourceKey)
      : undefined
    const liveChannelIds = detail ? serverDetailResourceChannelIds(detail) : undefined
    const canonicalTree = communityDb
      ? readServerTreeProjection(communityDb, id)
      : undefined
    let channelIds = liveChannelIds
      ?? (canonicalTree ? serverLandingChannelIds(canonicalTree.categories) : undefined)
      ?? []
    if (!detail && !lastChannel && channelIds.length === 0) {
      try {
        if (!scopeId || !resourceKey) throw new Error("community DB unavailable")
        const fetchedDetail = await queryClient.query<ServerDetailResource>({
          queryKey: resourceKey,
          queryFn: createServerDetailResourceQueryFn(queryClient, scopeId),
          staleTime: Infinity,
        })
        channelIds = serverDetailResourceChannelIds(fetchedDetail)
      } catch {
        channelIds = []
      }
    }
    return pickServerLandingHref(id, channelIds, lastChannel)
  }, [accountId, communityDb, queryClient])
  const onServerNavigate = useCallback((id: string) => {
    markSwitch("server", id)
    const rootHref = `/c/channels/${id}`
    if (breakpoint !== "desktop") {
      navigation.push(rootHref)
      return
    }
    void navigation.resolveAndPush(rootHref, () => serverDestination(id))
  }, [breakpoint, navigation, serverDestination])
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
    navigation.prefetch(`/c/channels/${id}`)
  }, [navigation])
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
    const rootHref = `/c/channels/${serverId}`
    if (breakpoint !== "desktop") {
      navigation.push(rootHref)
      return
    }
    void navigation.resolveAndPush(rootHref, () => serverDestination(serverId))
  }, [breakpoint, navigation, serverDestination])

  return {
    railProps: {
      servers: railServers,
      folders,
      activeServerId: projectedActiveServerId,
      serversLoading: servers.length === 0
        && (communityDb ? serverCollectionPending : !serversQuery.isSuccess),
      view: projectedView,
      onHome,
      onHomePrefetch,
      onServerNavigate,
      onServerPrefetch,
      onCreateServer,
      onLeaveServer: hasLiveServers ? onLeaveServer : undefined,
      onOpenSettings: hasLiveServers ? onOpenSettings : undefined,
      onOpenInvitePopover: hasLiveServers ? onOpenInvitePopover : undefined,
    },
    navigate,
  }
}
