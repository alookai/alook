"use client"

import { useEffect, useState, type ComponentProps, type ReactNode } from "react"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import { ChannelHeader, type ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { ChannelShell } from "@/components/community/channels/channel-shell"
import { CommunityPanelSheet } from "@/components/community/shell/community-panel-sheet"
import type { ChannelMemberPanelProps } from "@/components/community/channel-member-view-model"
import { Composer } from "@/components/community/messages/composer"
import { MessageContextSheet } from "@/components/community/messages/message-context-sheet"
import { MessageList } from "@/components/community/messages/message-list"
import {
  MessageChannelController,
} from "@/components/community/messages/message-channel-controller"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/profile-types"
import type { RightPanel } from "@/components/community/shell/panel-types"

export function TextChannelSurface({
  channelId,
  serverId,
  serverParam,
  channelName,
  viewer,
  anchorMessageId,
  headerServer,
  notificationLevel,
  onSetNotificationLevel,
  onBack,
  composerMembers,
  onSearchComposerMembers,
  channelRefCandidates,
  memberPanelProps,
  manageMembersDialog,
  uiHandlers,
  onOpenThread,
  onOpenProfile,
  resolveUserName,
}: {
  channelId: string
  serverId: string
  serverParam: string
  channelName: string
  viewer: { id: string; name: string; avatar: string }
  anchorMessageId: string | null
  headerServer?: { id: string; name: string; icon: string | null }
  notificationLevel: ChannelNotifLevel
  onSetNotificationLevel: (level: ChannelNotifLevel) => void
  onBack?: () => void
  composerMembers: ComponentProps<typeof Composer>["members"]
  onSearchComposerMembers: ComponentProps<typeof Composer>["onSearchMembers"]
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
}) {
  const breakpoint = useBreakpoint()
  const [rightPanel, setRightPanel] = useState<RightPanel>(null)
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
              rightPanel={rightPanel}
              onToggle={togglePanel}
              notifLevel={notificationLevel}
              onSetNotifLevel={onSetNotificationLevel}
              onBack={onBack}
              server={headerServer}
            />
          )}
          body={(
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
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
              <div data-onboarding-target="channel-composer" className="shrink-0">
                <Composer
                  channel={channelName}
                  context="channel"
                  members={composerMembers}
                  onSearchMembers={onSearchComposerMembers}
                  channelRefCandidates={channelRefCandidates}
                  sendContract="accepted"
                  onAcceptSend={controller.acceptMessage}
                  onTyping={controller.handleTyping}
                  replyingTo={controller.replyTo?.authorName}
                  onCancelReply={() => controller.setReplyTo(null)}
                  autoFocus={breakpoint !== "mobile"}
                  draftKey={`${serverId}/${channelId}`}
                />
              </div>
            </main>
          )}
          panels={rightPanel && (
            <CommunityPanelSheet
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
      )}
    </MessageChannelController>
  )
}
