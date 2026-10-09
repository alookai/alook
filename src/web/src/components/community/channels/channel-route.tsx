"use client"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { getCommunityRuntime } from "@/stores/community/runtime"


import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toastApiError } from "@/lib/api/client"
import { ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { ConversationMessageSkeleton } from "@/components/community/channels/conversation-message-skeleton"
import { ComposerSkeleton } from "@/components/community/messages/composer"
import { ForumViewSkeleton } from "@/components/community/channels/forum-view"
import { TextChannelSurface } from "@/components/community/channels/text-channel-surface"
import { ThreadChannelSurface } from "@/components/community/channels/thread-channel-surface"
import { ThreadSplitView } from "@/components/community/channels/thread-split-view"
import { ThreadSplitParentSurface } from "@/components/community/channels/thread-split-parent-surface"
import { ForumChannelSurface } from "@/components/community/channels/forum-channel-surface"
import { ConversationResolutionErrorFrame } from "@/components/community/channels/conversation-resolution-error-frame"
import { ConversationResolutionPendingFrame } from "@/components/community/channels/conversation-resolution-pending-frame"
import { useChannelMemberViewModel } from "@/components/community/members/channel-member-view-model"
import type { OpenProfile } from "@/components/community/social/profile-types"
import { canManageServer, USE_SERVER_DEFAULT } from "@alook/shared"
import { clearLastChannel } from "@/lib/community/last-channel"
import { commitCommunityChannelRoute } from "@/lib/community/last-community-route"
import { resolveChannelDisplayName } from "@/lib/community/channel-display-name"
import { toChannelRefCandidate } from "@/lib/community/channel-ref-extension"
import { useCurrentChannelId, useUiHandlers } from "@/stores/community"
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
import { resolveConversationSubtype } from "@/lib/community/conversation-subtype"
import { isConversationAccessError } from "@/lib/community/conversation-read"
import { useNativeSystemNotificationConversationDismissal } from "@/hooks/community/use-native-system-notifications"

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
  const [jumpTargetId, setJumpTargetId] = useAtom(useCreateAtom<string | null>((() => searchParams.get("msg"))()))
  const queryClient = useQueryClient()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const navigationGate = useConversationNavigationGate(
    queryClient,
    currentUser.id,
    channelId,
    accessEpoch,
  )
  const navigationTarget = navigationGate.target
  const currentAnchorMessageId = navigationTarget
    ? navigationTarget.anchorMessageId ?? null : jumpTargetId
  useLayoutEffect(() => {
    if (navigationTarget) setJumpTargetId(navigationTarget.anchorMessageId ?? null)
  }, [navigationTarget, setJumpTargetId])
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
const [topLevelRouteOwnership, setTopLevelRouteOwnership] = useAtom(useCreateAtom((() => ({
    channelId,
    wasTopLevel: channelInServer !== null,
  }))()))
  const routeWasTopLevel = topLevelRouteOwnership.channelId === channelId
    && topLevelRouteOwnership.wasTopLevel
  useLayoutEffect(() => {
    setTopLevelRouteOwnership((ownership) => {
      if (ownership.channelId !== channelId) {
        return { channelId, wasTopLevel: channelInServer !== null }
      }
      if (channelInServer !== null && !ownership.wasTopLevel) {
        return { channelId, wasTopLevel: true }
      }
      return ownership
    })
  }, [channelId, channelInServer, setTopLevelRouteOwnership])
  const forumPostOpener = useForumOpenerHint(
    serverId,
    currentChannelMeta?.parentMessageId,
    isForumPostChild && routeModel.routeHydrated && navigationGate.allowed,
  )
  const { isFetching: fetchingOpener, refetch: refetchOpener } = forumPostOpener
  const openerScope = JSON.stringify([currentUser.id, serverId, channelId, currentChannelMeta?.parentMessageId, accessEpoch])
  const [openerRetryAttempt, setOpenerRetryAttempt] = useAtom(useCreateAtom<{ scope: string } | null>(null))
  const openerRetryRef = useRef<{ scope: string } | null>(null)
  const retryingOpener = openerRetryAttempt?.scope === openerScope
  const openerError = isForumPostChild && (isConversationAccessError(forumPostOpener.error)
    || (!forumPostOpener.data && (forumPostOpener.isError || retryingOpener)))
  const retryOpener = useCallback(async () => {
    if (!openerError || fetchingOpener || openerRetryRef.current?.scope === openerScope) return
    const attempt = { scope: openerScope }
    openerRetryRef.current = attempt
    setOpenerRetryAttempt(attempt)
    try { await refetchOpener({ cancelRefetch: false }) }
    finally {
      if (openerRetryRef.current === attempt) openerRetryRef.current = null
      setOpenerRetryAttempt((current) => current === attempt ? null : current)
    }
  }, [fetchingOpener, refetchOpener, openerError, openerScope, setOpenerRetryAttempt])
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
    accessAllowed: routeModel.routeLifecycle === "ready" && navigationGate.allowed,
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
  const { containerRef: contentContainerRef, mode: threadSplitMode } = useThreadSplitMode({
    parentChannelId: currentChannelMeta?.parentChannelId ?? null,
    forceFullscreen: searchParams.get(THREAD_VIEW_PARAM) === "full",
  })

  const navigateServerRoot = useCallback(() => {
    uiHandlers.replacePath?.(serverRootHref(serverParam))
  }, [serverParam, uiHandlers])
  useEffect(() => {
    if (!routeWasTopLevel || channelInServer !== null
      || getCommunityRuntime(queryClient).ws.get().revokedServerIds.has(serverId)) return
    clearLastChannel(serverId)
    const survivor = currentServer?.categories
      .flatMap((category) => category.channels)
      .find((channel) => channel.id !== channelId && !channel.pending)
    router.replace(survivor
      ? channelHref(serverParam, survivor.id)
      : serverRootHref(serverParam))
  }, [channelId, channelInServer, currentServer, queryClient, routeWasTopLevel, router, serverId, serverParam])
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

  useEffect(() => {
    if (!jumpTargetId || !searchParams.has("msg") || searchParams.has(THREAD_OPENER_HANDOFF_PARAM)) return
    const search = searchParams.toString()
    const routePath = channelHref(serverParam, channelId)
    const href = `${routePath}${search ? `?${search}` : ""}`
    router.replace(
      removeCommunityParam(href, "msg"),
      { scroll: false },
    )
  }, [channelId, jumpTargetId, router, searchParams, serverParam])

  const enterThread = useCallback((id: string) => {
    getCommunityRuntime(queryClient).ui.get().uiHandlers.navigatePath?.(
      channelHref(serverParam, id),
    )
  }, [queryClient, serverParam])
  const openThreadFullscreen = useCallback(() => {
    uiHandlers.cancelPendingNavigation?.()
    const params = new URLSearchParams(searchParams.toString())
    params.set(THREAD_VIEW_PARAM, "full")
    router.push(`${channelHref(serverParam, channelId)}?${params.toString()}`, { scroll: false })
  }, [channelId, router, searchParams, serverParam, uiHandlers])

  const openProfile = useCallback<OpenProfile>((name, e, discriminator, userId) => {
    uiHandlers.openProfile?.(name, e, discriminator, userId)
  }, [uiHandlers])

  const channelReadReady =
    routeModel.routeLifecycle === "ready" &&
    currentChannelId === channelId &&
    routeModel.routeHydrated &&
    navigationGate.allowed
  const channelHydrated = channelReadReady &&
    (!isForumPostChild || (!forumPostOpener.isLoading && !openerError))
  useNativeSystemNotificationConversationDismissal(currentUser.id, {
    kind: "server",
    serverId,
    channelId,
  }, channelHydrated)
  // Route memory is an access-bearing navigation decision. Structural hints
  // can choose the skeleton, but only live data plus the current access gate
  // may commit the destination for a later cold entry.
  useEffect(() => {
    if (!channelHydrated) return
    commitCommunityChannelRoute(currentUser.id, serverId, channelId)
  }, [channelHydrated, channelId, currentUser.id, serverId])
  const subtype = resolveConversationSubtype({
    routeLifecycle: routeModel.routeLifecycle,
    accessAllowed: navigationGate.allowed,
    isChild: isChildChannel,
    isForum,
    structuralHint: routeModel.skeletonSubtype,
  })
  const content = (() => {
    if (navigationGate.failed) {
      return <ConversationResolutionErrorFrame retrying={false} onRetry={navigationGate.retry} />
    }
    if (routeModel.serverError) {
      return <ConversationResolutionErrorFrame retrying={routeModel.retryingServer}
        onRetry={() => { void routeModel.retryServer() }} />
    }
    if (routeModel.metadataError) {
      return <ConversationResolutionErrorFrame
        retrying={routeModel.retryingMetadata}
        onRetry={() => { void routeModel.retryMetadata() }}
      />
    }
    if (openerError) {
      return <ConversationResolutionErrorFrame retrying={retryingOpener}
        onRetry={() => { void retryOpener() }} />
    }
    if (subtype === "unknown") {
      return <ConversationResolutionPendingFrame />
    }
    // ── Child channel view (forum post / thread opened via URL) ─────────────
    if (subtype === "thread") {
      if (threadSplitMode === "pending") return <ConversationResolutionPendingFrame />
      const split = threadSplitMode === "split"
      return (
        <ThreadSplitView
          split={split}
          conversationSubtype="thread"
          parent={split ? channelReadReady && isChildChannel && currentServer && parentChannelInServer ? (
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
          ) : routeModel.layoutHint.parentSubtype === "unknown" ? (
            <ConversationResolutionPendingFrame />
          ) : (
            <>
              <ChannelHeaderSkeleton kind={routeModel.layoutHint.parentSubtype} />
              <main className="flex min-h-0 min-w-0 flex-1 flex-col">
                {routeModel.layoutHint.parentSubtype === "forum"
                  ? <ForumViewSkeleton />
                  : <ConversationMessageSkeleton />}
              </main>
            </>
          ) : null}
          thread={channelHydrated ? (
            <ThreadChannelSurface
              channelId={channelId}
              serverId={serverId}
              serverParam={serverParam}
              channelName={channelName}
              viewer={currentUser}
              canManagePins={canManageServer(myRole)}
              anchorMessageId={currentAnchorMessageId}
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
          ) : (
            <>
              <ChannelHeaderSkeleton kind="thread" compactActions={split} />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <ConversationMessageSkeleton />
                <ComposerSkeleton />
              </div>
            </>
          )}
        />
      )
    }

    if (!channelHydrated) return <ConversationResolutionPendingFrame subtype={subtype} />

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
        canManagePins={canManageServer(myRole)}
          anchorMessageId={currentAnchorMessageId}
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
  })()
  return (
    <div ref={contentContainerRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {content}
    </div>
  )

}
