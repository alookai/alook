import type { MessageChannelControllerValue } from "../../messaging"
import { Composer, MessageList } from "../../messaging"
import { MessageContextSheet } from "@/components/community/messages/message-context-sheet"
import { CommunityPanelSheet } from "@/components/community/shell/community-panel-sheet"
import type { RightPanel } from "@/components/community/shell/panel-types"
import { ChannelHeader } from "../channel-header"
import { ChannelShell } from "../channel-shell"
import type { TextChannelControllerProps } from "./text-channel-controller"

export type TextChannelViewProps = TextChannelControllerProps & {
  autoFocus: boolean
  rightPanel: RightPanel
  controller: MessageChannelControllerValue
  onTogglePanel: (panel: Exclude<RightPanel, null>) => void
  onClosePanel: () => void
}

export function TextChannelView({
  channelId,
  serverId,
  channelName,
  viewer,
  headerServer,
  notificationLevel,
  onSetNotificationLevel,
  onBack,
  composerMembers,
  onSearchComposerMembers,
  channelRefCandidates,
  memberPanelProps,
  manageMembersDialog,
  onOpenThread,
  onOpenProfile,
  resolveUserName,
  autoFocus,
  rightPanel,
  controller,
  onTogglePanel,
  onClosePanel,
}: TextChannelViewProps) {
  const feed = controller.feed
  return (
    <ChannelShell
      header={(
        <ChannelHeader
          channel={channelName}
          rightPanel={rightPanel}
          onToggle={onTogglePanel}
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
              autoFocus={autoFocus}
              draftKey={`${serverId}/${channelId}`}
            />
          </div>
        </main>
      )}
      panels={rightPanel && (
        <CommunityPanelSheet
          open
          onOpenChange={(open) => { if (!open) onClosePanel() }}
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
  )
}
