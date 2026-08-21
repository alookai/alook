"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { canManageServer, USE_SERVER_DEFAULT } from "@alook/shared"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelMemberViewModel } from "@/components/community/members/channel-member-view-model"
import type { OpenProfile } from "@/components/community/social/profile-types"
import { useCurrentUser } from "@/contexts/community/current-user"
import { toastApiError } from "@/lib/api/client"
import { resolveChannelDisplayName } from "@/lib/community/channel-display-name"
import { toChannelRefCandidate } from "@/lib/community/channel-ref-extension"
import { channelHref, removeCommunityParam } from "@/lib/community/community-route"
import { setLastChannel } from "@/lib/community/last-channel"
import { useForumOpenerHint } from "@/hooks/community/use-forum-opener-hint"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { useSetChannelNotif } from "@/hooks/community/mutations"
import {
  useCommunityStore,
  useCurrentChannelId,
  useUiHandlers,
} from "@/stores/community"
import type { ChannelNotifLevel } from "../channel-header"
import { ChannelView } from "./channel-view"
import { useChannelRouteModel } from "./channel-route-model"

export function ChannelController({ serverParam, channelId }: {
  serverParam: string
  channelId: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const serverId = decodeURIComponent(serverParam)
  useEffect(() => {
    setLastChannel(serverId, channelId)
  }, [serverId, channelId])
  const [jumpTargetId] = useState<string | null>(() => searchParams.get("msg"))
  const breakpoint = useBreakpoint()
  const currentUser = useCurrentUser()
  const uiHandlers = useUiHandlers()
  const currentChannelId = useCurrentChannelId()
  const routeModel = useChannelRouteModel(serverId, serverParam, channelId)
  const {
    server: currentServer,
    channel: channelInServer,
    parent: parentChannelInServer,
    currentChannelMeta,
    isForum,
    isChild: isChildChannel,
    isForumPostChild,
    isNotifyUnit,
  } = routeModel
  const forumPostOpener = useForumOpenerHint(
    serverId,
    currentChannelMeta?.parentMessageId,
    isForumPostChild && routeModel.routeHydrated,
  )
  const channelName = useMemo(() => resolveChannelDisplayName({
    forumPostTitle: isForumPostChild ? forumPostOpener.data?.content : null,
    topLevelName: channelInServer?.name,
    childChannelName: isForumPostChild ? null : currentChannelMeta?.name,
    forumListName: null,
    threadListName: null,
    fallback: isForumPostChild ? "Post" : "channel",
  }), [channelInServer, currentChannelMeta, forumPostOpener.data?.content, isForumPostChild])
  const memberViewModel = useChannelMemberViewModel({
    serverId,
    channelId,
    channelName,
    currentServer,
    channelInServer,
    currentChannelMeta,
    isChildChannel,
    isNotifyUnit,
    currentUser,
  })
  const {
    composerMembers,
    onSearchComposerMembers,
    memberPanelProps,
    manageMembersDialog,
    resolveUserName,
    myRole,
  } = memberViewModel
  const channelRefCandidates = useMemo(() => {
    if (!currentServer) return []
    return currentServer.categories
      .flatMap((category) => category.channels)
      .map((channel) => toChannelRefCandidate(currentServer, channel))
  }, [currentServer])
  const channelNotif = useNotificationSettings().channel
  const { mutate: setChannelNotif } = useSetChannelNotif()

  const goBack = useCallback(() => {
    const parentChannelId = currentChannelMeta?.parentChannelId
    if (isChildChannel && parentChannelId) {
      uiHandlers.replacePath?.(channelHref(serverParam, parentChannelId))
      return
    }
    uiHandlers.goBackMobile?.()
  }, [currentChannelMeta?.parentChannelId, isChildChannel, serverParam, uiHandlers])
  const setNotificationLevel = useCallback((level: ChannelNotifLevel) => {
    setChannelNotif({ channelId, level }, {
      onError: (error) => toastApiError(error, "Failed to update notification level"),
    })
  }, [channelId, setChannelNotif])

  useEffect(() => {
    if (!jumpTargetId) return
    const search = searchParams.toString()
    const routePath = channelHref(serverParam, channelId)
    const href = `${routePath}?${search}`
    router.replace(removeCommunityParam(href, "msg"), { scroll: false })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const enterThread = useCallback((id: string) => {
    useCommunityStore.getState().uiHandlers.navigatePath?.(channelHref(serverParam, id))
  }, [serverParam])
  const openProfile = useCallback<OpenProfile>((name, event, discriminator, userId) => {
    uiHandlers.openProfile?.(name, event, discriminator, userId)
  }, [uiHandlers])
  const onBack = breakpoint === "mobile" ? goBack : undefined
  const headerServer = breakpoint === "mobile" && currentServer
    ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon }
    : undefined
  const notificationLevel = (channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT
  const hydrated = currentChannelId === channelId
    && routeModel.routeHydrated
    && (!isForumPostChild || !forumPostOpener.isLoading)
  const shared = {
    channelId,
    serverId,
    channelName,
    viewer: currentUser,
    headerServer,
    notificationLevel,
    onSetNotificationLevel: setNotificationLevel,
    onBack,
    composerMembers,
    onSearchComposerMembers,
    memberPanelProps,
    manageMembersDialog,
    onOpenProfile: openProfile,
  }

  return (
    <ChannelView
      channelId={channelId}
      hydrated={hydrated}
      isForum={isForum}
      isChildChannel={isChildChannel}
      onBack={onBack}
      thread={{
        ...shared,
        serverParam,
        anchorMessageId: jumpTargetId,
        parentChannelId: currentChannelMeta?.parentChannelId ?? null,
        parentMessageId: currentChannelMeta?.parentMessageId ?? null,
        parentChannelName: parentChannelInServer?.name ?? "channel",
        parentIsForum: isForumPostChild,
        childCreatorId: currentChannelMeta?.creatorId,
        canRenameThread: canManageServer(myRole),
        channelRefCandidates,
        uiHandlers,
        onOpenChild: enterThread,
        resolveUserName,
      }}
      forum={{
        ...shared,
        viewerRole: myRole,
        onOpenPost: enterThread,
      }}
      text={{
        ...shared,
        serverParam,
        anchorMessageId: jumpTargetId,
        channelRefCandidates,
        uiHandlers,
        onOpenThread: enterThread,
        resolveUserName,
      }}
    />
  )
}
