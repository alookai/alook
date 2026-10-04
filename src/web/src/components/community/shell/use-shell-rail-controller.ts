"use client"

import { useCallback, useMemo, useLayoutEffect } from "react"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { useCreateAtom } from "@tanstack/react-store"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { communityServerId } from "@/lib/community/community-route"
import { markSwitch } from "@/lib/perf/switch-mark"
import { markVoluntaryLeave, pickPostEjectDestination } from "@/lib/community/eject-server"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { useServers } from "@/hooks/community/use-servers"
import { useFolders } from "@/hooks/community/use-folders"
import {
  useCreateServer,
  useLeaveServer,
  useUploadServerIcon,
} from "@/hooks/community/mutations"
import { getLastChannel, resolveCommunityLandingHref } from "@/lib/community/last-channel"
import { getLastMeLeaf } from "@/lib/community/last-me-location"
import type { Breakpoint } from "@/hooks/use-mobile"
import { resolveServerRailOverlayAction } from "./server-rail-actions"
import type { ShellFrameProps } from "./shell-frame-types"
import type { View } from "./shell-types"
import type { CommunityNavigationController } from "./use-community-navigation-controller"
import type { QueryClient } from "@tanstack/react-query"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"

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
  const origin = useCommunityMutationOrigin()
  const serversQuery = useServers()
  const foldersQuery = useFolders()
  const servers = serversQuery.servers
  const folders = foldersQuery.folders
  const hasLiveServers = servers.length > 0 || serversQuery.data !== undefined || !accountId
  const viewOwner = useCreateAtom({ active: false, generation: 0, navigation: null as CommunityNavigationController | null })
  useLayoutEffect(() => {
    viewOwner.set((state) => ({ ...state, active: true, generation: state.generation + 1 }))
    return () => viewOwner.set((state) => ({ ...state, active: false, generation: state.generation + 1 }))
  }, [communityDb, viewOwner])
  useLayoutEffect(() => { viewOwner.set((state) => ({ ...state, navigation })) }, [navigation, viewOwner])
  const viewCurrent = useCallback((generation: number) => viewOwner.get().active && viewOwner.get().generation === generation
    && !!communityDb?.runtime.lifecycle.get().active && getCommunityDbRegistry(queryClient) === communityDb, [communityDb, queryClient, viewOwner])
  const captureOperation = useCallback(() => {
    const generation = viewOwner.get().generation
    const token = origin.begin().token
    const authentication = communityDb!.authenticationView.get()
    const intentCurrent = navigation.captureIntent()
    const assertAccount = () => {
      origin.assertOwner(token)
      const current = communityDb!.authenticationView.get()
      if (!viewCurrent(generation) || !current.active || current.generation !== authentication.generation) {
        throw new DOMException("Retired rail account", "AbortError")
      }
    }
    const assertUi = () => {
      assertAccount()
      if (!intentCurrent()) throw new DOMException("Retired rail intent", "AbortError")
    }
    return { assertAccount, assertUi }
  }, [communityDb, navigation, origin, viewCurrent, viewOwner])
  const { mutateAsync: createServerAsync } = useCreateServer()
  const { mutate: leaveServerMutate } = useLeaveServer()
  const { mutate: uploadServerIconMutate } = useUploadServerIcon()
  const railServers = useMemo(
    () => servers
      .map((server) => ({ ...server, active: server.id === projectedActiveServerId })),
    [projectedActiveServerId, servers],
  )

  const serverDestination = useCallback((id: string) => {
    const complete = communityDb?.collections.servers.get(id)?.detailComplete === true
    const channelIds = communityDb && complete
      ? Array.from(communityDb.collections.channels.values()).filter((channel) => channel.serverId === id && channel.type !== "thread" && !channel.pending).map((channel) => channel.id)
      : []
    return resolveCommunityLandingHref({ serverId: id, channelIds, last: getLastChannel(id), breakpoint })
  }, [breakpoint, communityDb])
  const onServerNavigate = useCallback((id: string) => {
    markSwitch("server", id)
    navigation.push(serverDestination(id))
  }, [navigation, serverDestination])
  const homeDestination = useCallback(
    () => resolveCommunityLandingHref({ serverId: null, last: getLastMeLeaf(), breakpoint }),
    [breakpoint],
  )
  const onHome = useCallback(() => {
    navigation.push(homeDestination())
  }, [homeDestination, navigation])
  const onCreateServer = useCallback(async (name: string, icon?: File) => {
    const generation = viewOwner.get().generation
    if (!viewCurrent(generation)) return
    const { assertAccount, assertUi } = captureOperation()
    try {
      assertAccount()
      const data = await createServerAsync({ name })
      assertUi()
      const newId = data.server.id
      toast(`Server "${name}" created`)
      if (icon) {
        uploadServerIconMutate(
          { serverId: newId, file: icon },
          { onError: (error) => toastApiError(error, "Server created, but the icon failed to upload", assertUi) },
        )
      }
      navigation.push(`/c/channels/${newId}`)
    } catch (error) {
      toastApiError(error, "Failed to create server", assertUi)
    }
  }, [captureOperation, createServerAsync, navigation, uploadServerIconMutate, viewOwner, viewCurrent])
  const onLeaveServer = useCallback((id: string) => {
    const generation = viewOwner.get().generation
    if (!viewCurrent(generation)) return
    const { assertAccount, assertUi } = captureOperation()
    try { assertAccount() } catch { return }
    markVoluntaryLeave(queryClient, id)
    leaveServerMutate(
      { serverId: id },
      {
        onSuccess: () => {
          try { assertAccount() } catch { return }
          try { assertUi(); toast("Left server") } catch {}
          const currentNavigation = viewOwner.get().navigation
          if (currentNavigation && communityServerId(currentNavigation.navigationPending
            ? currentNavigation.pendingHref ?? ""
            : currentNavigation.publishedHref) === id) {
            const allowed = new Set([...communityDb!.collections.serverMemberships.values()].filter((row) => row.viewer && row.userId === communityDb!.accountId).map((row) => row.serverId))
            const remaining = [...communityDb!.collections.servers.values()].filter((row) => allowed.has(row.id)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
            currentNavigation.replace(pickPostEjectDestination(remaining, id))
          }
        },
        onError: (error) => toastApiError(error, "Failed to leave server", assertUi),
      },
    )
  }, [captureOperation, communityDb, leaveServerMutate, queryClient, viewCurrent, viewOwner])
  const onOpenSettings = useCallback((id?: string) => {
    if (!id) return
    const action = resolveServerRailOverlayAction({
      targetServerId: id,
      activeServerId,
      overlay: "settings",
      hasActiveOpener: !!onOpenActiveServerSettings,
      publishedHref: navigation.publishedHref,
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
      publishedHref: navigation.publishedHref,
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
      serversLoading: serversQuery.isPending && servers.length === 0,
      view: projectedView,
      onHome,
      onServerNavigate,
      onCreateServer,
      onLeaveServer: hasLiveServers ? onLeaveServer : undefined,
      onOpenSettings: hasLiveServers ? onOpenSettings : undefined,
      onOpenInvitePopover: hasLiveServers ? onOpenInvitePopover : undefined,
    },
    navigate,
  }
}
