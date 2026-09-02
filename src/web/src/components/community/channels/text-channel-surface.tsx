"use client"

import { useEffect, useState, type ComponentProps, type ReactNode } from "react"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import { ChannelHeader, type ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { ChannelShell } from "@/components/community/channels/channel-shell"
import { CommunityPanel } from "@/components/community/shell/community-panel"
import type { ChannelMemberPanelProps } from "@/components/community/members/channel-member-view-model"
import { Composer } from "@/components/community/messages/composer"
import { MessageContextSheet } from "@/components/community/messages/message-context-sheet"
import { MessageList } from "@/components/community/messages/message-list"
import { useAuthorMentionInsertion } from "@/components/community/messages/use-author-mention-insertion"
import {
  MessageChannelController,
} from "@/components/community/messages/message-channel-controller"
import { MessagePaneNavigationProvider } from "@/components/community/messages/message-pane-navigation"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { RightPanel } from "@/components/community/shell/panel-types"
import { tid } from "@/lib/community/testids"

export function TextChannelSurface({
  channelId,
  serverId,
  serverParam,
  channelName,
  viewer,
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
  viewer: { id: string; name: string; discriminator?: string; avatar: string }
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
  const [rightPanel, setRightPanel] = useState<RightPanel>(null)
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
  })
  useEffect(() => {
    setRightPanel(null)
  }, [channelId])

  const togglePanel = (panel: Exclude<RightPanel, null>) => {
    setRightPanel((current) => current === panel ? null : panel)
  }
  const Body = embedded ? "div" : "main"

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
        <MessagePaneNavigationProvider
          channelId={channelId}
          jumpToSeq={controller.jumpToSeq}
          openMessageContext={controller.setContextTarget}
        >
          <ChannelShell
            header={(
            <ChannelHeader
              channel={channelName}
              kind="text"
              rightPanel={rightPanel}
              onToggle={togglePanel}
              notifLevel={notificationLevel}
              onSetNotifLevel={onSetNotificationLevel}
              mobileBack={onNavigateParent}
            />
          )}
            body={(
            <Body className="flex min-h-0 min-w-0 flex-1 flex-col">
              <MessageList
                key={channelId}
                channel={channelName}
                messages={feed.messages}
                loading={feed.isLoading}
                pinnedIds={controller.pinnedIds}
                newDividerBefore={feed.newDividerBefore}
                typingUsers={controller.typingUsers}
                onOpenThread={onOpenThread}
                {...controller.messageActions}
                onOpenProfile={onOpenProfile}
                resolveUserName={resolveUserName}
                resolveAuthorMentionText={mentionInsertion.resolveAuthorMentionText}
                onInsertMentionText={mentionInsertion.insertMentionText}
                scrollToMessageId={controller.scrollTargetId}
                onScrollRoot={feed.setScrollRootEl}
                viewerUserId={viewer.id}
                initialScrollReady={!feed.readSnapshotFetching && feed.anchorInCache}
                onScrollTargetConsumed={controller.consumeScrollTarget}
                hasMore={feed.hasMoreOlder}
                isFetchingOlder={feed.isFetchingOlder}
                onLoadOlder={feed.fetchOlder}
                hasMoreNewer={feed.hasMoreNewer}
                isFetchingNewer={feed.isFetchingNewer}
                onLoadNewer={feed.fetchNewer}
                onJumpToPresent={feed.jumpToPresent}
                presentVersion={feed.presentVersion}
                unreadCount={feed.unreadCount}
              />
              <div
                data-onboarding-target="channel-composer"
                data-testid={tid.channelComposerShell}
                className="shrink-0"
              >
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
                  autoFocus={breakpoint === "desktop"}
                  draftKey={`${serverId}/${channelId}`}
                />
              </div>
            </Body>
          )}
            panels={rightPanel && (
            <CommunityPanel
              open
              onOpenChange={(open) => { if (!open) setRightPanel(null) }}
              kind={rightPanel}
              viewerUserId={viewer.id}
              {...memberPanelProps}
              pinned={feed.pinned}
              pinnedLoading={feed.pinnedLoading}
              searchResults={controller.searchResults}
              searchQuery={controller.searchQuery}
              threads={feed.threads}
              threadsLoading={feed.threadsLoading}
              onOpenThread={onOpenThread}
              onOpenProfile={onOpenProfile}
              onJumpToMessage={controller.jumpToSeq}
              onSearch={controller.search}
            />
          )}
            dialogs={(
            <>
              {manageMembersDialog}
              <MessageContextSheet
                open={controller.contextTarget !== null}
                onOpenChange={(open) => { if (!open) controller.setContextTarget(null) }}
                channelId={controller.contextTarget?.channelId ?? channelId}
                channelLabel={controller.contextTarget?.label}
                targetSeq={controller.contextTarget?.seq ?? null}
                pinnedIds={controller.pinnedIds}
                onOpenProfile={onOpenProfile}
                resolveUserName={resolveUserName}
                onReply={controller.onSheetReply}
              />
            </>
          )}
          />
        </MessagePaneNavigationProvider>
      )}
    </MessageChannelController>
  )
}
