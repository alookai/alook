"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useEffect, type ComponentProps, type ReactNode } from "react"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import { ChannelHeader, type ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { ChannelShell } from "@/components/community/channels/channel-shell"
import { CommunityPanel } from "@/components/community/shell/community-panel"
import type { ChannelMemberPanelProps } from "@/components/community/members/channel-member-view-model"
import { Composer } from "@/components/community/messages/composer"
import {
  ConversationFooterShell,
  ConversationFooterSlotProvider,
} from "@/components/community/messages/conversation-footer-shell"
import { MessageContextSheet } from "@/components/community/messages/message-context-sheet"
import { MessageList } from "@/components/community/messages/message-list"
import { useAuthorMentionInsertion } from "@/components/community/messages/use-author-mention-insertion"
import {
  MessageChannelController,
} from "@/components/community/messages/message-channel-controller"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { RightPanel } from "@/components/community/shell/panel-types"
import { tid } from "@/lib/community/testids"
import { ConversationActivityContext, useConversationActivity } from "@/contexts/community/conversation-activity"
import type { MessageHeaderTitleState } from "./message-header"

export function TextChannelSurface({
  channelId,
  serverId,
  serverParam,
  channelName,
  channelTitleState = "ready",
  viewer,
  canManagePins,
  anchorMessageId,
  onNavigateParent,
  notificationLevel,
  onSetNotificationLevel,
  composerMembers,
  composerMentionCandidates,
  channelRefCandidates,
  memberPanelProps,
  manageMembersDialog,
  uiHandlers,
  onOpenThread,
  onOpenProfile,
  resolveUserName,
  embedded = false,
}: {
  channelId: string
  serverId: string
  serverParam: string
  channelName: string
  channelTitleState?: MessageHeaderTitleState
  viewer: { id: string; name: string; discriminator?: string; avatar: string }
  canManagePins: boolean
  anchorMessageId: string | null
  onNavigateParent?: () => void
  notificationLevel: ChannelNotifLevel
  onSetNotificationLevel: (level: ChannelNotifLevel) => void
  composerMembers: ComponentProps<typeof Composer>["members"]
  composerMentionCandidates: ComponentProps<typeof Composer>["mentionCandidates"]
  channelRefCandidates: ComponentProps<typeof Composer>["channelRefCandidates"]
  memberPanelProps: ChannelMemberPanelProps
  manageMembersDialog: ReactNode
  uiHandlers: {
    navigate?: (serverId: string, channelId: string) => void
    previewImage?: (image: ImagePreview) => void
    previewAttachment?: (attachment: FileAttachment) => void
  }
  onOpenThread: (threadId: string) => void
  onOpenProfile: OpenProfile
  resolveUserName: (userId: string) => string
  embedded?: boolean
}) {
  const breakpoint = useBreakpoint()
  const routeActive = useConversationActivity()
  const [rightPanel, setRightPanel] = useAtom(useCreateAtom<RightPanel>(null))
  const mentionInsertion = useAuthorMentionInsertion({
    members: composerMembers,
    viewerUserId: viewer.id,
    viewerName: viewer.name,
    viewerDiscriminator: viewer.discriminator,
  })
  const feed = useChannelMessageFeed({
    channelId,
    serverId,
    viewerUserId: viewer.id,
    isChildChannel: false,
    anchorMessageId,
    threadsEnabled: rightPanel === "threads",
  })
  useEffect(() => {
    setRightPanel(null)
  }, [channelId, setRightPanel])

  const togglePanel = (panel: Exclude<RightPanel, null>) => {
    setRightPanel((current) => current === panel ? null : panel)
  }
  const Body = embedded ? "div" : "main"
  const inputActive = routeActive && feed.navigationBlocked === false

  return (
    <MessageChannelController
      channelId={channelId}
      serverId={serverId}
      serverParam={serverParam}
      channelName={channelName}
      viewer={viewer}
      anchorMessageId={anchorMessageId}
      feed={feed}
      uiHandlers={uiHandlers}
      onOpenThread={onOpenThread}
      onOpenPinned={() => setRightPanel("pinned")}
      resolveUserName={resolveUserName}
    >
      {(controller) => (
        <ChannelShell
          header={(
            <ChannelHeader
              channel={channelName}
              titleState={channelTitleState}
              kind="text"
              rightPanel={rightPanel}
              onToggle={togglePanel}
              notifLevel={notificationLevel}
              onSetNotifLevel={onSetNotificationLevel}
              mobileBack={onNavigateParent}
            />
          )}
          body={(
            <Body
              data-slot="community-conversation-surface"
              data-channel-id={channelId}
              data-testid={!embedded && feed.isLoading ? tid.conversationResolutionPending : undefined}
              aria-busy={!embedded && feed.isLoading ? true : undefined}
              aria-label={!embedded && feed.isLoading ? "Loading conversation" : undefined}
              data-community-conversation-subtype="text"
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              <ConversationFooterSlotProvider>
                <MessageList
                  key={channelId}
                  channel={channelName}
                  messages={feed.messages}
                  loading={feed.isLoading}
                  initialLoadError={feed.initialLoadError}
                  targetLoadError={feed.targetLoadError}
                  observation={feed.observation}
                  retryingInitialLoad={feed.retryingInitialLoad}
                  onRetryInitialLoad={feed.retryInitialLoad}
                  pinnedIds={controller.pinnedIds}
                  newDividerBefore={feed.newDividerBefore}
                  onOpenThread={onOpenThread}
                  {...controller.messageActions}
                  onPin={canManagePins ? controller.messageActions.onPin : undefined}
                  onOpenProfile={onOpenProfile}
                  resolveUserName={resolveUserName}
                  resolveAuthorMentionText={mentionInsertion.resolveAuthorMentionText}
                  onInsertMentionText={mentionInsertion.insertMentionText}
                  scrollToMessageId={controller.scrollTargetId}
                  onScrollRoot={feed.setScrollRootEl}
                  viewerUserId={viewer.id}
                  initialScrollReady={feed.initialDisplayReady}
                  preserveInitialPresentation={feed.preserveInitialPresentation}
                  onUserTakeover={feed.onUserTakeover}
                  onScrollTargetConsumed={controller.consumeScrollTarget}
                  hasMore={feed.hasMoreOlder}
                  historyStartKnown={feed.historyStartKnown}
                  initialPositionMessageId={feed.initialPositionMessageId}
                  positionEntry={feed.positionEntry}
                  positionScope={feed.positionScope}
                  positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState}
                  messageWindow={feed.messageWindow}
                  isFetching={feed.isFetching}
                  isFetchingOlder={feed.isFetchingOlder}
                  onLoadOlder={feed.fetchOlder}
                  hasMoreNewer={feed.hasMoreNewer}
                  isFetchingNewer={feed.isFetchingNewer}
                  onLoadNewer={feed.fetchNewer}
                  onJumpToPresent={feed.jumpToPresent}
                  presentVersion={feed.presentVersion}
                  presentRequest={feed.presentRequest}
                  localSubmitVersion={controller.localSubmitVersion}
                  unreadCount={feed.unreadCount}
                  typingUsers={controller.typingUsers}
                />
                <ConversationFooterShell
                  data-onboarding-target="channel-composer"
                  data-testid={tid.channelComposerShell}
                  inert={!inputActive}
                >
                  <ConversationActivityContext value={inputActive}>
                    <Composer
                      ref={mentionInsertion.composerRef}
                      channel={channelName}
                      context="channel"
                      members={composerMembers}
                      mentionCandidates={composerMentionCandidates}
                      channelRefCandidates={channelRefCandidates}
                      sendContract="accepted"
                      onAcceptSend={controller.acceptMessage}
                      onTyping={controller.handleTyping}
                      replyingTo={controller.replyTo ?? undefined}
                      onCancelReply={() => controller.setReplyTo(null)}
                      autoFocus={breakpoint === "desktop" && !embedded}
                      draftKey={`${serverId}/${channelId}`}
                    />
                  </ConversationActivityContext>
                </ConversationFooterShell>
              </ConversationFooterSlotProvider>
            </Body>
          )}
          panels={(
            <CommunityPanel
              open={rightPanel !== null}
              onOpenChange={(open) => { if (!open) setRightPanel(null) }}
              kind={rightPanel}
              {...memberPanelProps}
              pinned={feed.pinned}
              pinnedLoading={feed.pinnedLoading}
              threads={feed.threads}
              threadsLoading={feed.threadsLoading}
              onOpenThread={onOpenThread}
              onOpenProfile={onOpenProfile}
              onJumpToMessage={controller.jumpToSeq}
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
                pinnedIds={controller.pinnedIds}
                onOpenProfile={onOpenProfile}
                resolveUserName={resolveUserName}
                onReply={controller.onSheetReply}
                canManagePins={canManagePins}
                onOpenPinned={() => setRightPanel("pinned")}
              />
            </>
          )}
        />
      )}
    </MessageChannelController>
  )
}
