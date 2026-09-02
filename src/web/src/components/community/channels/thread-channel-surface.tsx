"use client"

import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { toastApiError, apiFetch } from "@/lib/api/client"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import { useEditMessage, useToggleReactionApi } from "@/hooks/community/mutations"
import { ChannelHeader, ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { ChannelShell } from "@/components/community/channels/channel-shell"
import { CommunityPanel } from "@/components/community/shell/community-panel"
import { Composer, ComposerSkeleton } from "@/components/community/messages/composer"
import { MessageChannelController } from "@/components/community/messages/message-channel-controller"
import { MessagePaneNavigationProvider } from "@/components/community/messages/message-pane-navigation"
import { MessageContextSheet } from "@/components/community/messages/message-context-sheet"
import { MessageList } from "@/components/community/messages/message-list"
import { useAuthorMentionInsertion } from "@/components/community/messages/use-author-mention-insertion"
import { ThreadOpener } from "@/components/community/messages/thread-opener"
import { ThreadPanelActions } from "@/components/community/channels/thread-panel-actions"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { RightPanel } from "@/components/community/shell/panel-types"
import type { ChannelMemberPanelProps } from "@/components/community/members/channel-member-view-model"
import { tid } from "@/lib/community/testids"
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
  viewer,
  anchorMessageId,
  parentChannelId,
  parentMessageId,
  parentIsForum,
  threadOpenerHandoff,
  childCreatorId,
  canRenameThread,
  onNavigateParent,
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
}: {
  channelId: string
  serverId: string
  serverParam: string
  channelName: string
  viewer: { id: string; name: string; discriminator?: string; avatar: string }
  anchorMessageId: string | null
  parentChannelId: string | null
  parentMessageId: string | null
  parentIsForum: boolean
  threadOpenerHandoff?: ThreadOpenerReadHandoff | null
  childCreatorId?: string | null
  canRenameThread: boolean
  onNavigateParent: () => void
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
  onOpenChild: (childId: string) => void
  onOpenProfile: OpenProfile
  resolveUserName: (userId: string) => string
  embedded?: boolean
  splitActions?: { onFullscreen: () => void; onClose: () => void }
}) {
  const router = useRouter()
  const breakpoint = useBreakpoint()
  const [rightPanel, setRightPanel] = useState<RightPanel>(null)
  const [localName, setLocalName] = useState<string | null>(null)
  const mentionInsertion = useAuthorMentionInsertion({
    members: composerMembers,
    viewerUserId: viewer.id,
    viewerName: viewer.name,
    viewerDiscriminator: viewer.discriminator,
  })
  const { mutateAsync: editMessageAsync } = useEditMessage()
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
    isChildChannel: true,
    anchorMessageId,
  })
  const displayName = localName ?? channelName
  const Body = embedded ? "div" : "main"

  useEffect(() => {
    setRightPanel(null)
    setLocalName(null)
  }, [channelId])

  const togglePanel = useCallback((panel: Exclude<RightPanel, null>) => {
    setRightPanel((current) => current === panel ? null : panel)
  }, [])
  const openPinned = useCallback(() => setRightPanel("pinned"), [])
  const rename = parentIsForum && parentChannelId && parentMessageId && childCreatorId === viewer.id
    ? async (name: string) => {
        try {
          await editMessageAsync({
            serverId,
            channelId: parentChannelId,
            messageId: parentMessageId,
            content: name,
            forumChannelId: parentChannelId,
            forumThreadId: channelId,
          })
        } catch (error) {
          toastApiError(error, "Failed to edit post")
          throw error
        }
      }
    : !parentIsForum && canRenameThread
      ? async (name: string) => {
          try {
            await apiFetch(`/api/community/channels/${channelId}`, {
              method: "PATCH",
              body: JSON.stringify({ name }),
            })
            setLocalName(name)
          } catch (error) {
            toastApiError(error, "Failed to rename")
            throw error
          }
        }
      : undefined

  if (feed.isLoading) {
    return (
      <>
        <ChannelHeaderSkeleton />
        <Body className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList key={channelId} channel="" messages={[]} loading onOpenThread={ignoreNestedThread} />
          <ComposerSkeleton />
        </Body>
      </>
    )
  }

  const opener = parentMessageId && !parentIsForum ? (
    <ThreadOpener
      parentMessageId={parentMessageId}
      viewerUserId={viewer.id}
      onOpenProfile={onOpenProfile}
      onToggleReaction={parentChannelId ? toggleOpenerReaction : undefined}
      resolveUserName={resolveUserName}
      resolveAuthorMentionText={mentionInsertion.resolveAuthorMentionText}
      onInsertMentionText={mentionInsertion.insertMentionText}
      onPreviewImage={(image) => uiHandlers.previewImage?.(image)}
      onPreviewAttachment={(attachment) => uiHandlers.previewAttachment?.(attachment)}
      onJump={parentChannelId
        ? () => router.push(`/c/channels/${serverParam}/${parentChannelId}?msg=${parentMessageId}`)
        : undefined}
    />
  ) : undefined

  return (
    <MessageChannelController
      channelId={channelId}
      serverId={serverId}
      serverParam={serverParam}
      channelName={displayName}
      forumParentChannelId={parentIsForum ? parentChannelId ?? undefined : undefined}
      viewer={viewer}
      anchorMessageId={anchorMessageId}
      feed={feed}
      uiHandlers={uiHandlers}
      onOpenThread={ignoreNestedThread}
      onOpenPinned={openPinned}
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
              channel={displayName}
              kind="thread"
              rightPanel={rightPanel}
              onToggle={togglePanel}
              notifLevel={notificationLevel}
              onSetNotifLevel={onSetNotificationLevel}
              mobileBack={onNavigateParent}
              tools={{ threads: false }}
              titleRename={parentIsForum}
              onRename={parentChannelId && !splitActions ? rename : undefined}
              compactActions={!!splitActions}
              endActions={splitActions ? (
                <ThreadPanelActions
                  onFullscreen={splitActions.onFullscreen}
                  onClose={splitActions.onClose}
                />
              ) : undefined}
            />
          )}
            body={(
            <Body className="flex min-h-0 min-w-0 flex-1 flex-col">
              <MessageList
                key={channelId}
                channel={displayName}
                messages={controller.feed.messages}
                loading={controller.feed.isLoading}
                pinnedIds={controller.pinnedIds}
                newDividerBefore={controller.feed.newDividerBefore}
                typingUsers={controller.typingUsers}
                onOpenThread={ignoreNestedThread}
                {...controller.threadActions}
                onOpenProfile={onOpenProfile}
                resolveUserName={resolveUserName}
                resolveAuthorMentionText={mentionInsertion.resolveAuthorMentionText}
                onInsertMentionText={mentionInsertion.insertMentionText}
                scrollToMessageId={controller.scrollTargetId}
                hero={opener}
                onScrollRoot={controller.feed.setScrollRootEl}
                viewerUserId={viewer.id}
                initialScrollReady={!controller.feed.readSnapshotFetching && controller.feed.anchorInCache}
                onScrollTargetConsumed={controller.consumeScrollTarget}
                hasMore={controller.feed.hasMoreOlder}
                isFetchingOlder={controller.feed.isFetchingOlder}
                onLoadOlder={controller.feed.fetchOlder}
                hasMoreNewer={controller.feed.hasMoreNewer}
                isFetchingNewer={controller.feed.isFetchingNewer}
                onLoadNewer={controller.feed.fetchNewer}
                onJumpToPresent={controller.feed.jumpToPresent}
                presentVersion={controller.feed.presentVersion}
                unreadCount={controller.feed.unreadCount}
              />
              <div
                data-onboarding-target="channel-composer"
                data-testid={tid.channelComposerShell}
                className="shrink-0"
              >
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
              pinned={controller.feed.pinned}
              pinnedLoading={controller.feed.pinnedLoading}
              searchResults={controller.searchResults}
              searchQuery={controller.searchQuery}
              threads={controller.feed.threads}
              threadsLoading={controller.feed.threadsLoading}
              onOpenThread={onOpenChild}
              onJumpToMessage={controller.jumpToSeq}
              onSearch={controller.search}
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
