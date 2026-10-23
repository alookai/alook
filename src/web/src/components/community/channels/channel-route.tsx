"use client"
import { useAtom, useCreateAtom } from "@tanstack/react-store";


import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import { useSearchParams } from "next/navigation"
import { useCommunityHistoryRouter as useRouter } from "@/lib/community/navigation"
import { toastApiError } from "@/lib/api/client"
import { ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { ConversationMessageSkeleton } from "@/components/community/channels/conversation-message-skeleton"
import { ComposerSkeleton } from "@/components/community/messages/composer"
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
import { commitCommunityChannelRoute } from "@/lib/community/last-community-route"
import { resolveChannelDisplayName } from "@/lib/community/channel-display-name"
import { toChannelRefCandidate } from "@/lib/community/channel-ref-extension"
import { useCurrentChannelId, useUiHandlers } from "@/stores/community"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useChannelRouteModel } from "@/hooks/community/use-channel-route-model"
import { useForumOpenerHint } from "@/hooks/community/use-forum-opener-hint"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { useSetChannelNotif } from "@/hooks/community/mutations"
import { channelHref, normalizeCommunityHref, removeCommunityParam, serverRootHref } from "@/lib/community/community-route"
import { useCommunityRouteFrame } from "@/components/community/shell/community-route-context"
import {
  THREAD_OPENER_HANDOFF_PARAM,
  useThreadOpenerRouteGate,
} from "@/hooks/community/thread-opener-read-handoff"
import { useThreadSplitMode } from "@/hooks/community/use-thread-split-mode"
import { useCommunityWsStore } from "@/stores/community/ws"
import { resolveConversationSubtype } from "@/lib/community/conversation-subtype"
import { isConversationAccessError } from "@/lib/community/conversation-read"
import { MobilePage } from "@/components/community/shell/mobile-page"
import { ConversationActivityContext, ConversationPresentationContext, useConversationActivity } from "@/contexts/community/conversation-activity"
import { useRouteChannelProjection } from "@/lib/community-db/projections"
import { useNativeSystemNotificationConversationDismissal } from "@/hooks/community/use-native-system-notifications"

const THREAD_VIEW_PARAM = "threadView"

type RouteTarget = {
  serverId: string
  serverParam: string
  channelId: string
  searchParams: URLSearchParams
  routeCommitted: boolean
  anchorMessageId: string | null
  resume: boolean
  routeModel: ReturnType<typeof useChannelRouteModel>
  currentUser: ReturnType<typeof useCurrentUser>
}

type ChannelRouteProps = {
  serverParam: string
  channelId: string
  targetHref?: string
  routeCommitted?: boolean
}

export function ChannelRoute(props: ChannelRouteProps) {
  return <MobileChannelRoutes {...props} />
}

function MobileChannelRoutes(props: ChannelRouteProps) {
  const { breakpoint } = useCommunityRouteFrame()
  const [mobileSeen, setMobileSeen] = useState(breakpoint === "mobile")
  if (breakpoint === "mobile" && !mobileSeen) setMobileSeen(true)
  const [initialId, setInitialId] = useState(props.channelId)
  if (!mobileSeen && breakpoint !== "mobile" && initialId !== props.channelId) setInitialId(props.channelId)
  const identity = useRouteChannelProjection(props.channelId)
  const parentId = identity?.parentChannelId
  const [retained, setRetained] = useState({ current: props.channelId, previous: null as string | null })
  if (retained.current !== props.channelId) setRetained({ current: props.channelId, previous: retained.current })
  const previous = retained.current !== props.channelId ? retained.current : retained.previous
  const backgroundId = mobileSeen || breakpoint === "mobile" ? parentId ?? (identity === undefined ? previous : null) : null
  const ids = backgroundId && backgroundId !== props.channelId ? [backgroundId, props.channelId] : [props.channelId]
  return <>{ids.map(id => <ConversationActivityContext key={!mobileSeen && breakpoint !== "mobile" || id === initialId ? "initial" : id} value={id === props.channelId && props.routeCommitted !== false}>
    <ConversationPresentationContext value={id === props.channelId}>
      <ChannelRouteLayer {...props} channelId={id} foreground={id === props.channelId} backgroundVisible={id === parentId} routeCommitted={id === props.channelId ? props.routeCommitted : true} targetHref={id === props.channelId ? props.targetHref : channelHref(props.serverParam, id)} />
    </ConversationPresentationContext>
  </ConversationActivityContext>)}</>
}

function ChannelRouteLayer({ serverParam, channelId, targetHref, routeCommitted = true, backgroundVisible = true, foreground = true }: {
  serverParam: string
  channelId: string
  targetHref?: string
  routeCommitted?: boolean
  backgroundVisible?: boolean
  foreground?: boolean
}) {
  const committedSearch = useSearchParams()
  const search = targetHref === undefined ? committedSearch.toString() : normalizeCommunityHref(targetHref).search
  const searchParams = useMemo(() => new URLSearchParams(search), [search])
  const serverId = decodeURIComponent(serverParam)
  const currentUser = useCurrentUser()
  const { navigation } = useCommunityRouteFrame()
  const matchingIntent = navigation.entryIntent && normalizeCommunityHref(navigation.entryIntent.href).pathname === channelHref(serverParam, channelId) ? navigation.entryIntent : null
  const resume = matchingIntent?.resume === true
  const entryIntent = resume ? null : matchingIntent
  const routeAnchorMessageId = searchParams.get("msg")
  const intentAnchorMessageId = entryIntent ? new URLSearchParams(normalizeCommunityHref(entryIntent.href).search).get("msg") : undefined
  const scope = JSON.stringify([currentUser.id, serverId, channelId])
  const [captured, setCaptured] = useAtom(useCreateAtom({ scope, anchorMessageId: routeAnchorMessageId }))
  const anchorMessageId = intentAnchorMessageId !== undefined ? intentAnchorMessageId
    : routeAnchorMessageId ?? (captured.scope === scope ? captured.anchorMessageId : null)
  useLayoutEffect(() => {
    if (resume && captured.scope === scope) return
    if (!entryIntent && routeAnchorMessageId === null && routeCommitted && captured.scope === scope) return
    const next = intentAnchorMessageId !== undefined ? intentAnchorMessageId : routeAnchorMessageId
    setCaptured(current => current.scope === scope && current.anchorMessageId === next ? current : { scope, anchorMessageId: next })
  }, [resume, scope, captured.scope, entryIntent, intentAnchorMessageId, routeAnchorMessageId, routeCommitted, setCaptured])
  const routeModel = useChannelRouteModel(serverId, serverParam, channelId, currentUser.id, anchorMessageId)
  const content = <ChannelRouteFrame key={JSON.stringify([currentUser.id, serverId])}
    serverId={serverId} serverParam={serverParam} channelId={channelId}
    searchParams={searchParams} routeCommitted={routeCommitted} resume={resume}
    routeModel={routeModel} anchorMessageId={anchorMessageId} currentUser={currentUser} />
  return <MobilePage active={foreground} backgroundVisible={backgroundVisible}
    parentPath={routeModel.layoutHint.parentChannelId ? channelHref(serverParam, routeModel.layoutHint.parentChannelId) : serverRootHref(serverParam)}>
    {content}
  </MobilePage>
}

function ChannelRouteFrame(target: RouteTarget) {
  const { serverId, serverParam, channelId, searchParams, routeModel, currentUser } = target
  const parentChannelId = routeModel.layoutHint.parentChannelId
  const server = routeModel.server
  const parent = parentChannelId ? (routeModel.parent?.id === parentChannelId ? routeModel.parent
    : server?.categories.flatMap(category => category.channels).find(channel => channel.id === parentChannelId && !channel.pending))
    ?? { id: parentChannelId, name: "", active: false, unread: false } : null
  const { navigation, breakpoint } = useCommunityRouteFrame()
  const isThread = routeModel.skeletonSubtype === "thread"
    || routeModel.routeLifecycle === "ready" && routeModel.isChild
  const { containerRef, mode } = useThreadSplitMode({
    breakpoint,
    enabled: isThread,
    forceFullscreen: searchParams.get(THREAD_VIEW_PARAM) === "full",
  })
  const uiHandlers = useUiHandlers()
  const split = isThread && mode === "split"
  const layoutPending = isThread && mode === "pending"
  const [parentIdentity, setParentIdentity] = useAtom(useCreateAtom<{ id: string; confirmed: boolean } | null>(null))
  const onParentIdentity = useCallback((id: string, confirmed: boolean) => {
    setParentIdentity((current) => current?.id === id && current.confirmed === confirmed ? current : { id, confirmed })
  }, [setParentIdentity])
  const resolvingParent = split && routeModel.routeLifecycle !== "ready" &&
    (!parent || parentIdentity?.id !== parent.id || !parentIdentity.confirmed)
  const channelRefCandidates = useMemo(() => server?.categories
    .flatMap((category) => category.channels)
    .map((channel) => toChannelRefCandidate(server, channel)) ?? [], [server])
  const enterThread = useCallback((id: string) => {
    if (split) navigation.push(channelHref(serverParam, id), { scroll: false })
    else navigation.push(channelHref(serverParam, id))
  }, [navigation, serverParam, split])
  const navigateServerRoot = useCallback(() => {
    uiHandlers.goBackMobile(serverRootHref(serverParam))
  }, [serverParam, uiHandlers])
  const openProfile = useCallback<OpenProfile>((name, event, discriminator, userId) => {
    uiHandlers.openProfile?.(name, event, discriminator, userId)
  }, [uiHandlers])
  const pane = <ChannelTargetPane key={JSON.stringify([currentUser.id, serverId, channelId])}
    {...target} split={split} layoutPending={layoutPending} resolvingParent={resolvingParent} onOpenChild={enterThread} />
  const targetHref = `${channelHref(serverParam, channelId)}${searchParams.size ? `?${searchParams}` : ""}`
  return <div ref={containerRef} data-community-target-href={targetHref} className="flex min-h-0 min-w-0 flex-1 flex-col max-sm:fixed max-sm:inset-0 max-sm:z-20 max-sm:bg-background">
    <ThreadSplitView
      split={split} layoutPending={layoutPending} resolvingParent={resolvingParent} conversationSubtype={isThread ? "thread" : routeModel.skeletonSubtype}
      parent={split && parent ? <ThreadSplitParentSurface
        key={JSON.stringify([currentUser.id, serverId, parent.id])}
        serverId={serverId} serverParam={serverParam} server={server} channel={parent}
        viewer={currentUser} onNavigateParent={navigateServerRoot}
        channelRefCandidates={channelRefCandidates} uiHandlers={uiHandlers}
        onOpenChild={enterThread} onOpenProfile={openProfile} onIdentity={onParentIdentity} /> : null}
      thread={pane} />
  </div>
}

function QualifiedThreadSurface({ routeLifecycle, ...props }: ComponentProps<typeof ThreadChannelSurface> & {
  routeLifecycle: RouteTarget["routeModel"]["routeLifecycle"]
}) {
  const threadOpenerHandoff = useThreadOpenerRouteGate({
    serverId: props.serverId,
    childChannelId: props.channelId,
    parentChannelId: props.parentChannelId,
    openerMessageId: props.parentMessageId,
    lifecycle: routeLifecycle,
  })
  return <ThreadChannelSurface {...props} threadOpenerHandoff={threadOpenerHandoff} />
}

function ChannelTargetPane({ serverId, serverParam, channelId, searchParams, routeCommitted, resume,
  routeModel, anchorMessageId, currentUser, split, layoutPending, resolvingParent, onOpenChild }: RouteTarget & {
  split: boolean
  layoutPending: boolean
  resolvingParent: boolean
  onOpenChild: (id: string) => void
}) {
  const active = useConversationActivity()
  const { navigation } = useCommunityRouteFrame()
  const router = useRouter()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const currentAnchorMessageId = anchorMessageId
  const uiHandlers = useUiHandlers()
  const currentChannelId = useCurrentChannelId()
  const {
    server: currentServer,
    channel: channelInServer,
    currentChannelMeta,
    isForum,
    isChild: isChildChannel,
    isForumPostChild,
    isNotifyUnit,
  } = routeModel
  const forumPostOpener = useForumOpenerHint(
    serverId,
    currentChannelMeta?.parentMessageId,
    isForumPostChild && !resolvingParent && routeModel.routeHydrated,
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
    accessAllowed: !resolvingParent && routeCommitted && routeModel.routeLifecycle === "ready",
    roleDisplayAllowed: !resolvingParent && routeModel.routeLifecycle === "ready"
      && (routeCommitted || resume && isForum && routeModel.routeHydrated),
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

  const navigateServerRoot = useCallback(() => {
    uiHandlers.goBackMobile(serverRootHref(serverParam))
  }, [serverParam, uiHandlers])
  const navigateParent = useCallback(() => {
    const parentChannelId = currentChannelMeta?.parentChannelId
    if (!parentChannelId) return
    uiHandlers.goBackMobile(channelHref(serverParam, parentChannelId))
  }, [currentChannelMeta?.parentChannelId, serverParam, uiHandlers])
  const setNotificationLevel = useCallback((level: ChannelNotifLevel) => {
    setChannelNotif({ channelId, level }, {
      onError: (error) => toastApiError(error, "Failed to update notification level"),
    })
  }, [channelId, setChannelNotif])

  useEffect(() => {
    if (!active || !routeCommitted || !anchorMessageId || !searchParams.has("msg") || searchParams.has(THREAD_OPENER_HANDOFF_PARAM)) return
    const search = searchParams.toString()
    const routePath = channelHref(serverParam, channelId)
    const href = `${routePath}${search ? `?${search}` : ""}`
    router.replace(
      removeCommunityParam(href, "msg"),
      { scroll: false },
    )
  }, [active, channelId, anchorMessageId, routeCommitted, router, searchParams, serverParam])
  const openThreadFullscreen = useCallback(() => {
    uiHandlers.cancelPendingNavigation?.()
    const params = new URLSearchParams(searchParams.toString())
    params.set(THREAD_VIEW_PARAM, "full")
    navigation.push(`${channelHref(serverParam, channelId)}?${params.toString()}`, { scroll: false })
  }, [channelId, navigation, searchParams, serverParam, uiHandlers])

  const openProfile = useCallback<OpenProfile>((name, e, discriminator, userId) => {
    uiHandlers.openProfile?.(name, e, discriminator, userId)
  }, [uiHandlers])

  const channelReadReady =
    routeModel.routeLifecycle === "ready" &&
    routeModel.routeHydrated
  const channelHydrated = !resolvingParent && channelReadReady &&
    (!isForumPostChild || (Boolean(forumPostOpener.data) && !openerError))
  const clientReady = active && routeCommitted && channelHydrated && currentChannelId === channelId
  useNativeSystemNotificationConversationDismissal(currentUser.id, {
    kind: "server",
    serverId,
    channelId,
  }, clientReady)
  // Route memory is an access-bearing navigation decision. Structural hints
  // can choose the skeleton, but only live data plus the current access gate
  // may commit the destination for a later cold entry.
  useEffect(() => {
    if (!clientReady) return
    commitCommunityChannelRoute(currentUser.id, serverId, channelId)
  }, [clientReady, channelId, currentUser.id, serverId])
  const subtype = resolveConversationSubtype({
    routeLifecycle: routeModel.routeLifecycle,
    accessAllowed: routeModel.routeHydrated,
    isChild: isChildChannel,
    isForum,
    structuralHint: routeModel.skeletonSubtype,
  })
  const content = (() => {
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
    if (subtype === "thread") {
      return channelHydrated ? (
        <QualifiedThreadSurface
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
              routeLifecycle={routeCommitted ? routeModel.routeLifecycle : "pending"}
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
              onOpenChild={onOpenChild}
              onOpenProfile={openProfile}
              resolveUserName={resolveUserName}
              embedded
              layoutPending={layoutPending}
              splitActions={split || layoutPending ? {
                onFullscreen: openThreadFullscreen,
                onClose: navigateParent,
              } : undefined}
        />
      ) : (
        <>
          <ChannelHeaderSkeleton kind="thread" compactActions={split} layoutPending={layoutPending} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ConversationMessageSkeleton />
            <ComposerSkeleton />
          </div>
        </>
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
          routeTag={searchParams.get("tag")}
          onSelectTag={(tag) => {
            const next = new URLSearchParams(searchParams)
            next.set("tag", tag === "All" ? "" : tag)
            navigation.replace(`${channelHref(serverParam, channelId)}?${next}`)
          }}
          viewer={currentUser}
          viewerRole={myRole}
          onNavigateParent={navigateServerRoot}
          notificationLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
          onSetNotificationLevel={setNotificationLevel}
          composerMembers={composerMembers}
          composerMentionCandidates={composerMentionCandidates}
          memberPanelProps={memberPanelProps}
          manageMembersDialog={manageMembersDialog}
          onOpenPost={onOpenChild}
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
        onOpenThread={onOpenChild}
        onOpenProfile={openProfile}
        resolveUserName={resolveUserName}
      />
    )
  })()
  return content
}
