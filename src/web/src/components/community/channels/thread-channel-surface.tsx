"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { useCallback, useEffect, type ComponentProps, type ReactNode } from "react"
import { useCommunityRouter } from "@/contexts/community/module-route"
import { toastApiError } from "@/lib/api/client"
import { isAbortError } from "@/lib/errors"
import { useRenameChannel } from "@/hooks/community/mutations"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import { useToggleReactionApi } from "@/hooks/community/mutations"
import { ChannelHeader, type ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { CommunityPanel } from "@/components/community/shell/community-panel"
import { Composer } from "@/components/community/messages/composer"
import { MessageChannelController } from "@/components/community/messages/message-channel-controller"
import { MessageContextSheet } from "@/components/community/messages/message-context-sheet"
import { useAuthorMentionInsertion } from "@/components/community/messages/use-author-mention-insertion"
import { ThreadOpener } from "@/components/community/messages/thread-opener"
import { ThreadPanelActions } from "@/components/community/channels/thread-panel-actions"
import { ConversationSurface } from "./conversation-surface"
import type { MessageHeaderTitleState } from "./message-header"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { RightPanel } from "@/components/community/shell/panel-types"
import type { ChannelMemberPanelProps } from "@/components/community/members/channel-member-view-model"
import { tid } from "@/lib/community/testids"
import { useConversationActivity } from "@/contexts/view-activity"
import {
  useClaimThreadOpenerReadHandoff,
  type ThreadOpenerReadHandoff,
} from "@/hooks/community/thread-opener-read-handoff"

const ignoreNestedThread = () => {}

export function ThreadChannelSurface({
  channelId,
  serverId,
  serverParam,
  channelName,
  channelTitleState = "ready",
  onRetryTitle,
  retryingTitle,
  viewer,
  canManagePins,
  anchorMessageId,
  parentChannelId,
  parentMessageId,
  parentIsForum,
  threadOpenerHandoff,
  canRenameThread,
  onNavigateParent,
  onLeaveChannel,
  notificationLevel,
  onSetNotificationLevel,
  composerMembers,
  composerMentionCandidates,
  channelRefCandidates,
  memberPanelProps,
  manageMembersDialog,
  uiHandlers,
  onOpenChild,
  onOpenProfile,
  resolveUserName,
  embedded = false,
  splitActions,
  layoutPending = false,
}: {
  channelId: string
  serverId: string
  serverParam: string
  channelName: string
  channelTitleState?: MessageHeaderTitleState
  onRetryTitle?: () => void
  retryingTitle?: boolean
  viewer: { id: string; name: string; discriminator?: string; avatar: string }
  canManagePins: boolean
  anchorMessageId: string | null
  parentChannelId: string | null
  parentMessageId: string | null
  parentIsForum: boolean
  threadOpenerHandoff?: ThreadOpenerReadHandoff | null
  canRenameThread: boolean
  onNavigateParent: () => void
  onLeaveChannel?: () => Promise<void>
  notificationLevel: ChannelNotifLevel
  onSetNotificationLevel: (level: ChannelNotifLevel) => void
  composerMembers: ComponentProps<typeof Composer>["members"]
  composerMentionCandidates: ComponentProps<typeof Composer>["mentionCandidates"]
  channelRefCandidates: ComponentProps<typeof Composer>["channelRefCandidates"]
  memberPanelProps: ChannelMemberPanelProps
  manageMembersDialog: ReactNode
  uiHandlers: {
    cancelPendingNavigation?: () => void
    navigate?: (serverId: string, channelId: string) => void
    previewImage?: (image: ImagePreview) => void
    previewAttachment?: (attachment: FileAttachment) => void
  }
  onOpenChild: (childId: string) => void
  onOpenProfile: OpenProfile
  resolveUserName: (userId: string) => string
  embedded?: boolean
  splitActions?: { onFullscreen: () => void; onClose: () => void }
  layoutPending?: boolean
}) {
  const router = useCommunityRouter()
  const breakpoint = useBreakpoint()
  const [rightPanel, setRightPanel] = useAtom(useCreateAtom<RightPanel>(null))
  const renameChannel = useRenameChannel()
  const renameView = useCommunityViewSource(JSON.stringify(["thread-rename", serverId, channelId]))
  const mentionInsertion = useAuthorMentionInsertion({
    members: composerMembers,
    viewerUserId: viewer.id,
    viewerName: viewer.name,
    viewerDiscriminator: viewer.discriminator,
  })
  const toggleReactionApi = useToggleReactionApi()
  const toggleOpenerReaction = useCallback((emoji: string) => {
    if (!parentChannelId || !parentMessageId) return
    toggleReactionApi({
      serverId,
      channelId: parentChannelId,
      messageId: parentMessageId,
      emoji,
      userId: viewer.id,
    })
  }, [parentChannelId, parentMessageId, serverId, toggleReactionApi, viewer.id])
  useClaimThreadOpenerReadHandoff(threadOpenerHandoff)
  const feed = useChannelMessageFeed({
    channelId,
    serverId,
    viewerUserId: viewer.id,
    anchorMessageId,
    threadsEnabled: rightPanel === "threads",
  })
  const displayName = channelName
  const routeActive = useConversationActivity()
  const inputActive = routeActive && feed.navigationBlocked === false
  const compactActions = !!splitActions && !layoutPending

  useEffect(() => {
    setRightPanel(null)
  }, [channelId, setRightPanel])

  const togglePanel = useCallback((panel: Exclude<RightPanel, null>) => {
    setRightPanel((current) => current === panel ? null : panel)
  }, [setRightPanel])
  const openPinned = useCallback(() => setRightPanel("pinned"), [setRightPanel])
  const rename = !parentIsForum && canRenameThread
      ? async (name: string) => {
          const assert = renameView.capture()
          try {
            assert()
            await renameChannel.mutateAsync({ serverId, channelId, name })
            assert()
          } catch (error) {
            if (!isAbortError(error)) {
              assert()
              toastApiError(error, "Failed to rename")
            }
            throw error
          }
        }
      : undefined

  const opener = parentMessageId && !parentIsForum ? (
    <ThreadOpener
      parentMessageId={parentMessageId}
      parentChannelId={parentChannelId}
      serverId={serverId}
      viewerUserId={viewer.id}
      onOpenProfile={onOpenProfile}
      onToggleReaction={parentChannelId ? toggleOpenerReaction : undefined}
      resolveUserName={resolveUserName}
      resolveAuthorMentionText={mentionInsertion.resolveAuthorMentionText}
      onInsertMentionText={mentionInsertion.insertMentionText}
      onPreviewImage={(image) => uiHandlers.previewImage?.(image)}
      onPreviewAttachment={(attachment) => uiHandlers.previewAttachment?.(attachment)}
      onJump={parentChannelId
        ? () => {
            uiHandlers.cancelPendingNavigation?.()
            router.push(`/c/channels/${serverParam}/${parentChannelId}?msg=${parentMessageId}`)
          }
        : undefined}
    />
  ) : undefined

  return (
    <MessageChannelController
      channelId={channelId}
      serverId={serverId}
      serverParam={serverParam}
      channelName={displayName}
      forumParentChannelId={parentChannelId ?? undefined}
      viewer={viewer}
      anchorMessageId={anchorMessageId}
      feed={feed}
      uiHandlers={uiHandlers}
      onOpenThread={ignoreNestedThread}
      onOpenPinned={openPinned}
      resolveUserName={resolveUserName}
    >
      {(controller) => (
        <ConversationSurface
          channelId={channelId}
          subtype="thread"
          embedded={embedded}
          loadingPending={controller.feed.isLoading}
          loadingPendingLabel="Loading thread"
          header={(
            <ChannelHeader
              channel={displayName}
              titleState={channelTitleState}
              onRetryTitle={onRetryTitle}
              retryingTitle={retryingTitle}
              kind="thread"
              rightPanel={rightPanel}
              onToggle={togglePanel}
              notifLevel={notificationLevel}
              onSetNotifLevel={onSetNotificationLevel}
              mobileBack={compactActions ? undefined : onNavigateParent}
              mobileBackDisplay="always"
              tools={{ threads: false }}
              onRename={parentChannelId && !compactActions ? rename : undefined}
              onLeave={!compactActions && onLeaveChannel ? async () => { await onLeaveChannel(); onNavigateParent() } : undefined}
              compactActions={compactActions}
              endActions={splitActions ? (
                <ThreadPanelActions
                  onFullscreen={splitActions.onFullscreen}
                  onClose={splitActions.onClose}
                />
              ) : undefined}
            />
          )}
          messageListProps={{
            onOpenContextId: controller.openContextId,
            channel: displayName,
            kind: "thread",
            messages: controller.feed.messages,
            loading: controller.feed.isLoading,
            initialLoadError: controller.feed.initialLoadError,
            targetLoadError: controller.feed.targetLoadError,
            retryingInitialLoad: controller.feed.retryingInitialLoad,
            onRetryInitialLoad: controller.feed.retryInitialLoad,
            pinnedIds: controller.pinnedIds,
            newDividerBefore: controller.feed.newDividerBefore,
            newBoundary: controller.feed.newBoundary,
            latestSeq: controller.feed.latestSeq,
            retiredNewTargetId: controller.feed.retiredNewTargetId,
            onLoadNewTarget: controller.feed.loadNewTarget,
            onReadNewBoundary: controller.feed.readNewBoundary,
            onOpenThread: ignoreNestedThread,
            ...controller.threadActions,
            onSubmitDecisionCard: controller.sendDecisionReply,
            onPin: canManagePins ? controller.threadActions.onPin : undefined,
            onOpenProfile,
            resolveUserName,
            resolveAuthorMentionText: mentionInsertion.resolveAuthorMentionText,
            onInsertMentionText: mentionInsertion.insertMentionText,
            scrollToMessageId: controller.scrollTargetId,
            hero: opener,
            onScrollRoot: controller.feed.setScrollRootEl,
            viewerUserId: viewer.id,
            initialScrollReady: controller.feed.initialDisplayReady,
            preserveInitialPresentation: controller.feed.preserveInitialPresentation,
            onUserTakeover: controller.feed.onUserTakeover,
            onScrollTargetConsumed: controller.consumeScrollTarget,
            hasMore: controller.feed.hasMoreOlder,
            historyStartKnown: controller.feed.historyStartKnown,
            initialPositionMessageId: controller.feed.initialPositionMessageId,
            positionEntry: controller.feed.positionEntry,
            positionScope: controller.feed.positionScope,
            positionDataState: controller.feed.positionDataState,
            targetPositionDataState: controller.feed.targetPositionDataState,
            messageWindow: controller.feed.messageWindow,
            messageNeighborhood: controller.feed.messageNeighborhood,
            onReadingMessage: controller.feed.onReadingMessage,
            isFetching: controller.feed.isFetching,
            isFetchingOlder: controller.feed.isFetchingOlder,
            onLoadOlder: controller.feed.fetchOlder,
            onFillHistory: controller.feed.fillHistory,
            hasMoreNewer: controller.feed.hasMoreNewer,
            isFetchingNewer: controller.feed.isFetchingNewer,
            onLoadNewer: controller.feed.fetchNewer,
            onJumpToPresent: controller.feed.jumpToPresent,
            presentVersion: controller.feed.presentVersion,
            presentRequest: controller.feed.presentRequest,
            olderLoadError: controller.feed.olderLoadError,
            newerLoadError: controller.feed.newerLoadError,
            presentPending: controller.feed.presentPending,
            presentError: controller.feed.presentError,
            localSubmitVersion: controller.localSubmitVersion,
            unreadCount: controller.feed.unreadCount,
            typingScope: controller.typingScope,
            typingUsers: controller.typingUsers,
          }}
          footerProps={{
            "data-onboarding-target": "channel-composer",
            "data-testid": tid.channelComposerShell,
            inert: !inputActive,
          }}
          inputActive={inputActive}
          footer={(
            <Composer
              ref={mentionInsertion.composerRef}
              channel={displayName}
              context="thread"
              members={composerMembers}
              mentionCandidates={composerMentionCandidates}
              channelRefCandidates={channelRefCandidates}
              sendContract="accepted"
              onAcceptSend={controller.acceptMessage}
              onTyping={controller.handleTyping}
              replyingTo={controller.replyTo ?? undefined}
              onCancelReply={() => controller.setReplyTo(null)}
              autoFocus={breakpoint === "desktop"}
              draftKey={`${serverId}/${channelId}`}
            />
          )}
          sidePanel={(
            <CommunityPanel
              open={rightPanel !== null}
              onOpenChange={(open) => { if (!open) setRightPanel(null) }}
              kind={rightPanel}
              {...memberPanelProps}
              pinned={controller.feed.pinned}
              pinnedLoading={controller.feed.pinnedLoading}
              pinnedKnown={controller.feed.pinnedKnown}
              pinnedError={controller.feed.pinnedError}
              onRetryPinned={controller.feed.retryPinned}
              threads={controller.feed.threads}
              threadsLoading={controller.feed.threadsLoading}
              threadsKnown={controller.feed.threadsKnown}
              threadsError={controller.feed.threadsError}
              onRetryThreads={controller.feed.retryThreads}
              onOpenThread={onOpenChild}
              onJumpToMessage={controller.jumpToSeq}
              onOpenProfile={onOpenProfile}
            />
          )}
          dialogs={(
            <>
              {manageMembersDialog}
              <MessageContextSheet
                open={controller.contextTarget !== null}
                onOpenChange={(open) => { if (!open) controller.setContextTarget(null) }}
                channelId={controller.contextTarget?.channelId ?? channelId}
                serverId={controller.contextTarget?.serverId ?? serverId}
                channelLabel={controller.contextTarget?.label}
                targetSeq={controller.contextTarget?.seq ?? null}
                targetMessageId={controller.contextTarget?.messageId}
                pinnedIds={controller.pinnedIds}
                onOpenProfile={onOpenProfile}
                resolveUserName={resolveUserName}
                onReply={controller.onSheetReply}
                canManagePins={canManagePins}
                onOpenPinned={openPinned}
              />
            </>
          )}
        />
      )}
    </MessageChannelController>
  )
}
