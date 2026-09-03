"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toastApiError } from "@/lib/api/client"
import { ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { MessageList } from "@/components/community/messages/message-list"
import { ComposerSkeleton } from "@/components/community/messages/composer"
import { ForumViewSkeleton } from "@/components/community/channels/forum-view"
import { TextChannelSurface } from "@/components/community/channels/text-channel-surface"
import { ThreadChannelSurface } from "@/components/community/channels/thread-channel-surface"
import { ThreadSplitView } from "@/components/community/channels/thread-split-view"
import { ThreadSplitParentSurface } from "@/components/community/channels/thread-split-parent-surface"
import { ForumChannelSurface } from "@/components/community/channels/forum-channel-surface"
import { useChannelMemberViewModel } from "@/components/community/members/channel-member-view-model"
import type { OpenProfile } from "@/components/community/social/profile-types"
import { canManageServer, USE_SERVER_DEFAULT } from "@alook/shared"
import { setLastChannel } from "@/lib/community/last-channel"
import { commitLastCommunityRoute } from "@/lib/community/last-community-route"
import { resolveChannelDisplayName } from "@/lib/community/channel-display-name"
import { toChannelRefCandidate } from "@/lib/community/channel-ref-extension"
import {
  useCommunityStore,
  useCurrentChannelId,
  useUiHandlers,
} from "@/stores/community"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useChannelRouteModel } from "@/hooks/community/use-channel-route-model"
import { useForumOpenerHint } from "@/hooks/community/use-forum-opener-hint"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { useSetChannelNotif } from "@/hooks/community/mutations"
import { channelHref, removeCommunityParam, serverRootHref } from "@/lib/community/community-route"
import {
  THREAD_OPENER_HANDOFF_PARAM,
  useThreadOpenerRouteGate,
} from "@/hooks/community/thread-opener-read-handoff"
import { useThreadSplitMode } from "@/hooks/community/use-thread-split-mode"
import { useQueryClient } from "@tanstack/react-query"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useConversationNavigationGate } from "@/lib/community/conversation-navigation-proof"

const THREAD_VIEW_PARAM = "threadView"

/**
 * /c/channels/:serverId/:channelId
 *
 * - Forum channel: ForumView
 * - Text channel: MessageList + Composer + right panels
 * - Child thread opened via URL: child-channel view (current identity + list)
 */
export function ChannelRoute({ serverParam, channelId }: {
  serverParam: string
  channelId: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const serverId = decodeURIComponent(serverParam)
  const currentUser = useCurrentUser()
  // Remember this as the server's last-opened channel (per-browser navigation
  // memory) so re-entering the server restores here instead of the default.
  // Pure localStorage write; failures are swallowed in the helper.
  useEffect(() => {
    setLastChannel(serverId, channelId)
  }, [serverId, channelId])
  // Cross-channel "jump to message" target, captured ONCE at mount from `?msg=`.
  // `ChannelView` is keyed by `serverId/channelId`, so a fresh jump remounts and
  // re-reads this. The param is stripped from the URL right after (below) so a
  // refresh/back doesn't re-trigger the jump; this frozen copy still drives the
  // anchor + scroll for this mount.
  const [jumpTargetId] = useState<string | null>(() => searchParams.get("msg"))
  const queryClient = useQueryClient()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const navigationGate = useConversationNavigationGate(
    queryClient,
    currentUser.id,
    channelId,
    accessEpoch,
  )
  const uiHandlers = useUiHandlers()
  const currentChannelId = useCurrentChannelId()
  const routeModel = useChannelRouteModel(serverId, serverParam, channelId, currentUser.id)
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
  useEffect(() => {
    if (routeModel.routeLifecycle !== "ready") return
    commitLastCommunityRoute(currentUser.id, channelHref(serverId, channelId))
  }, [channelId, currentUser.id, routeModel.routeLifecycle, serverId])
  const forumPostOpener = useForumOpenerHint(
    serverId,
    currentChannelMeta?.parentMessageId,
    isForumPostChild && routeModel.routeHydrated,
  )
  const threadOpenerHandoff = useThreadOpenerRouteGate({
    serverId,
    childChannelId: channelId,
    parentChannelId: currentChannelMeta?.parentChannelId ?? null,
    openerMessageId: currentChannelMeta?.parentMessageId ?? null,
    lifecycle: routeModel.routeLifecycle,
  })
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
    composerMentionCandidates,
    memberPanelProps,
    manageMembersDialog,
    resolveUserName,
    myRole,
  } = memberViewModel

  // `/`-autocomplete candidates for both Composer call sites below — single
  // server, so no directory hook needed here (see `me/[dmId]/page.tsx` for
  // the cross-server DM case).
  const channelRefCandidates = useMemo(() => {
    if (!currentServer) return []
    return currentServer.categories
      .flatMap((category) => category.channels)
      .map((channel) => toChannelRefCandidate(currentServer, channel))
  }, [currentServer])
  const notifs = useNotificationSettings()
  const channelNotif = notifs.channel
  const { mutate: setChannelNotif } = useSetChannelNotif()
  const threadSplit = useThreadSplitMode({
    parentChannelId: currentChannelMeta?.parentChannelId ?? null,
    forceFullscreen: searchParams.get(THREAD_VIEW_PARAM) === "full",
  })

  const navigateServerRoot = useCallback(() => {
    uiHandlers.replacePath?.(serverRootHref(serverParam))
  }, [serverParam, uiHandlers])
  const navigateParent = useCallback(() => {
    const parentChannelId = currentChannelMeta?.parentChannelId
    if (!parentChannelId) return
    uiHandlers.replacePath?.(channelHref(serverParam, parentChannelId))
  }, [currentChannelMeta?.parentChannelId, serverParam, uiHandlers])
  const setNotificationLevel = useCallback((level: ChannelNotifLevel) => {
    setChannelNotif({ channelId, level }, {
      onError: (error) => toastApiError(error, "Failed to update notification level"),
    })
  }, [channelId, setChannelNotif])

  // Strip `?msg=` from the URL right after mount so a refresh/back doesn't
  // re-trigger the jump. The frozen `jumpTargetId` still seeds the mounted
  // message controller for this mount; this only cleans the address.
  useEffect(() => {
    if (!jumpTargetId || searchParams.has(THREAD_OPENER_HANDOFF_PARAM)) return
    const search = searchParams.toString()
    const routePath = channelHref(serverParam, channelId)
    const href = `${routePath}${search ? `?${search}` : ""}`
    router.replace(
      removeCommunityParam(href, "msg"),
      { scroll: false },
    )
  }, [channelId, jumpTargetId, router, searchParams, serverParam])

  const enterThread = useCallback((id: string) => {
    useCommunityStore.getState().uiHandlers.navigatePath?.(
      channelHref(serverParam, id),
    )
  }, [serverParam])
  const openThreadFullscreen = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.set(THREAD_VIEW_PARAM, "full")
    router.push(`${channelHref(serverParam, channelId)}?${params.toString()}`, { scroll: false })
  }, [channelId, router, searchParams, serverParam])

  const openProfile = useCallback<OpenProfile>((name, e, discriminator, userId) => {
    uiHandlers.openProfile?.(name, e, discriminator, userId)
  }, [uiHandlers])

  const channelHydrated =
    currentChannelId === channelId &&
    routeModel.routeHydrated &&
    (!isForumPostChild || !forumPostOpener.isLoading) &&
    navigationGate.allowed
  if (!channelHydrated) {
    if (isForum) {
      return (
        <>
          <ChannelHeaderSkeleton />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ForumViewSkeleton />
          </main>
        </>
      )
    }
    return (
      <>
        <ChannelHeaderSkeleton />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
            `key={channelId}` MUST match the hydrated branches' key below —
            verified empirically (react-test-renderer) that a mismatched key
            (this branch had none before) is what causes React to treat this
            and the hydrated-branch `<MessageList>` as different component
            identities, forcing a full unmount/remount instead of a props
            update on one instance when `channelHydrated` flips true. With
            matching keys, this works correctly even though this early
            `return` and the hydrated branches' `return` produce
            structurally different JSX trees — React's reconciliation only
            needs the position + type + key to line up.
          */}
          <MessageList key={channelId} channel="" messages={[]} loading={true} onOpenThread={() => { }} />
          <ComposerSkeleton />
        </main>
      </>
    )
  }

  // ── Child channel view (forum post / thread opened via URL) ─────────────
  if (isChildChannel) {
    const split = threadSplit.mode === "split" && !!currentServer && !!parentChannelInServer
    return (
      <ThreadSplitView
        containerRef={threadSplit.containerRef}
        split={split}
        parent={split && currentServer && parentChannelInServer ? (
          <ThreadSplitParentSurface
            serverId={serverId}
            serverParam={serverParam}
            server={currentServer}
            channel={parentChannelInServer}
            viewer={currentUser}
            onNavigateParent={navigateServerRoot}
            channelRefCandidates={channelRefCandidates}
            uiHandlers={uiHandlers}
            onOpenChild={enterThread}
            onOpenProfile={openProfile}
          />
        ) : null}
        thread={(
          <ThreadChannelSurface
            channelId={channelId}
            serverId={serverId}
            serverParam={serverParam}
            channelName={channelName}
            viewer={currentUser}
            anchorMessageId={jumpTargetId}
            parentChannelId={currentChannelMeta?.parentChannelId ?? null}
            parentMessageId={currentChannelMeta?.parentMessageId ?? null}
            parentIsForum={isForumPostChild}
            threadOpenerHandoff={threadOpenerHandoff}
            childCreatorId={currentChannelMeta?.creatorId}
            canRenameThread={canManageServer(myRole)}
            onNavigateParent={navigateParent}
            notificationLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
            onSetNotificationLevel={setNotificationLevel}
            composerMembers={composerMembers}
            composerMentionCandidates={composerMentionCandidates}
            channelRefCandidates={channelRefCandidates}
            memberPanelProps={memberPanelProps}
            manageMembersDialog={manageMembersDialog}
            uiHandlers={uiHandlers}
            onOpenChild={enterThread}
            onOpenProfile={openProfile}
            resolveUserName={resolveUserName}
            embedded
            splitActions={split ? {
              onFullscreen: openThreadFullscreen,
              onClose: navigateParent,
            } : undefined}
          />
        )}
      />
    )
  }

  // ── Forum view ──────────────────────────────────────────────────────────
  if (isForum) {
    return (
      <ForumChannelSurface
        serverId={serverId}
        channelId={channelId}
        channelName={channelName}
        viewer={currentUser}
        viewerRole={myRole}
        onNavigateParent={navigateServerRoot}
        notificationLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
        onSetNotificationLevel={setNotificationLevel}
        composerMembers={composerMembers}
        composerMentionCandidates={composerMentionCandidates}
        memberPanelProps={memberPanelProps}
        manageMembersDialog={manageMembersDialog}
        onOpenPost={enterThread}
        onOpenProfile={openProfile}
      />
    )
  }

  // ── Standard channel view ───────────────────────────────────────────────
  return (
    <TextChannelSurface
      channelId={channelId}
      serverId={serverId}
      serverParam={serverParam}
      channelName={channelName}
      viewer={currentUser}
      anchorMessageId={jumpTargetId}
      onNavigateParent={navigateServerRoot}
      notificationLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
      onSetNotificationLevel={setNotificationLevel}
      composerMembers={composerMembers}
      composerMentionCandidates={composerMentionCandidates}
      channelRefCandidates={channelRefCandidates}
      memberPanelProps={memberPanelProps}
      manageMembersDialog={manageMembersDialog}
      uiHandlers={uiHandlers}
      onOpenThread={enterThread}
      onOpenProfile={openProfile}
      resolveUserName={resolveUserName}
    />
  )
}
