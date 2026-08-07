"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toastApiError } from "@/lib/api/client"
import { useBreakpoint } from "@/hooks/use-mobile"
import { ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channel-header"
import { MessageList } from "@/components/community/message-list"
import { ComposerSkeleton } from "@/components/community/composer"
import { ForumViewSkeleton } from "@/components/community/forum-view"
import { TextChannelSurface } from "@/components/community/text-channel-surface"
import { ThreadChannelSurface } from "@/components/community/thread-channel-surface"
import { ForumChannelSurface } from "@/components/community/forum-channel-surface"
import { useChannelMemberViewModel } from "@/components/community/channel-member-view-model"
import type { OpenProfile } from "@/components/community/_types"
import { canManageServer } from "@/components/community/_types"
import { USE_SERVER_DEFAULT } from "@alook/shared"
import { setLastChannel } from "@/lib/community/last-channel"
import { resolveChannelDisplayName } from "@/lib/community/channel-display-name"
import {
  useCurrentChannelId,
  useUiHandlers,
} from "@/stores/community"
import { useCurrentUser } from "@/contexts/community/current-user"
import { useChannelRouteModel } from "@/hooks/community/use-channel-route-model"
import { useMessage } from "@/hooks/community/use-message"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { useSetChannelNotif } from "@/hooks/community/mutations"

/**
 * /c/channels/:serverId/:channelId
 *
 * - Forum channel: ForumView
 * - Text channel: MessageList + Composer + right panels
 * - Child thread opened via URL: child-channel view (breadcrumb + list)
 */
export function ChannelRoute({ serverParam, channelId }: { serverParam: string; channelId: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const serverId = decodeURIComponent(serverParam)
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
  const bp = useBreakpoint()
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
  const { message: forumPostOpener, isLoading: forumPostOpenerLoading } = useMessage(
    isForumPostChild ? currentChannelMeta?.parentMessageId : null,
  )
  const channelName = useMemo(() => resolveChannelDisplayName({
    forumPostTitle: isForumPostChild ? forumPostOpener?.content : null,
    topLevelName: channelInServer?.name,
    childChannelName: isForumPostChild ? null : currentChannelMeta?.name,
    forumListName: null,
    threadListName: null,
    fallback: isForumPostChild ? "Post" : "channel",
  }), [channelInServer, currentChannelMeta, forumPostOpener, isForumPostChild])
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

  // `/`-autocomplete candidates for both Composer call sites below — single
  // server, so no directory hook needed here (see `me/[dmId]/page.tsx` for
  // the cross-server DM case).
  const channelRefCandidates = useMemo(() => {
    const allChannels = currentServer?.categories?.flatMap((c) => c.channels) ?? []
    return allChannels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      serverId,
      serverName: currentServer?.name ?? "",
    }))
  }, [currentServer, serverId])
  const notifs = useNotificationSettings()
  const channelNotif = notifs.channel
  const { mutate: setChannelNotif } = useSetChannelNotif()

  const goBack = useCallback(() => { uiHandlers.goBackMobile?.() }, [uiHandlers])
  const goRouteBack = useCallback(() => { router.back() }, [router])
  const setNotificationLevel = useCallback((level: ChannelNotifLevel) => {
    setChannelNotif({ channelId, level }, {
      onError: (error) => toastApiError(error, "Failed to update notification level"),
    })
  }, [channelId, setChannelNotif])

  // Strip `?msg=` from the URL right after mount so a refresh/back doesn't
  // re-trigger the jump. The frozen `jumpTargetId` still seeds the mounted
  // message controller for this mount; this only cleans the address.
  useEffect(() => {
    if (!jumpTargetId) return
    router.replace(`/c/channels/${serverParam}/${channelId}`, { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for this mount's jump
  }, [])

  const enterThread = useCallback((id: string) => {
    // No eager read PUT here — the thread page's `useEagerChannelRead` fires it
    // on mount AFTER its read-state snapshot latches, so the "New" divider
    // still anchors to the pre-open pointer. A PUT here would race the snapshot.
    router.push(`/c/channels/${serverParam}/${id}`)
  }, [router, serverParam])

  const openProfile = useCallback<OpenProfile>((name, e, discriminator, userId) => {
    uiHandlers.openProfile?.(name, e, discriminator, userId)
  }, [uiHandlers])

  const channelHydrated =
    currentChannelId === channelId &&
    routeModel.routeHydrated &&
    (!isForumPostChild || !forumPostOpenerLoading)
  if (!channelHydrated) {
    if (isForum) {
      return (
        <>
          <ChannelHeaderSkeleton onBack={bp === "mobile" ? goBack : undefined} />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ForumViewSkeleton />
          </main>
        </>
      )
    }
    return (
      <>
        <ChannelHeaderSkeleton onBack={bp === "mobile" ? goBack : undefined} />
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
    return (
      <ThreadChannelSurface
        channelId={channelId}
        serverId={serverId}
        serverParam={serverParam}
        channelName={channelName}
        viewer={currentUser}
        anchorMessageId={jumpTargetId}
        parentChannelId={currentChannelMeta?.parentChannelId ?? null}
        parentMessageId={currentChannelMeta?.parentMessageId ?? null}
        parentChannelName={parentChannelInServer?.name ?? "channel"}
        parentIsForum={isForumPostChild}
        childCreatorId={currentChannelMeta?.creatorId}
        canRenameThread={canManageServer(myRole)}
        headerServer={bp === "mobile" && currentServer
          ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon }
          : undefined}
        notificationLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
        onSetNotificationLevel={setNotificationLevel}
        onBack={bp === "mobile" ? goRouteBack : undefined}
        onLoadingBack={bp === "mobile" ? goBack : undefined}
        composerMembers={composerMembers}
        onSearchComposerMembers={onSearchComposerMembers}
        channelRefCandidates={channelRefCandidates}
        memberPanelProps={memberPanelProps}
        manageMembersDialog={manageMembersDialog}
        uiHandlers={uiHandlers}
        onOpenChild={enterThread}
        onOpenProfile={openProfile}
        resolveUserName={resolveUserName}
      />
    )
  }

  // ── Forum view ──────────────────────────────────────────────────────────
  if (isForum) {
    return (
      <ForumChannelSurface
        serverId={serverId}
        channelId={channelId}
        serverId={serverId}
        channelName={channelName}
        viewer={currentUser}
        viewerRole={myRole}
        headerServer={bp === "mobile" && currentServer
          ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon }
          : undefined}
        notificationLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
        onSetNotificationLevel={setNotificationLevel}
        onBack={bp === "mobile" ? goBack : undefined}
        composerMembers={composerMembers}
        onSearchComposerMembers={onSearchComposerMembers}
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
      headerServer={bp === "mobile" && currentServer
        ? { id: currentServer.id, name: currentServer.name, icon: currentServer.icon }
        : undefined}
      notificationLevel={(channelNotif[channelId] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT}
      onSetNotificationLevel={setNotificationLevel}
      onBack={bp === "mobile" ? goBack : undefined}
      composerMembers={composerMembers}
      onSearchComposerMembers={onSearchComposerMembers}
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
