"use client"

import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { toastApiError, apiFetch } from "@/lib/api/client"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import { useEditMessage } from "@/hooks/community/mutations"
import { ChannelHeader, ChannelHeaderSkeleton, type ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { ChannelShell } from "@/components/community/channels/channel-shell"
import { CommunityPanelSheet } from "@/components/community/shell/community-panel-sheet"
import { Composer, ComposerSkeleton } from "@/components/community/messages/composer"
import { MessageChannelController } from "@/components/community/messages/message-channel-controller"
import { MessageContextSheet } from "@/components/community/messages/message-context-sheet"
import { MessageList } from "@/components/community/messages/message-list"
import { ThreadOpener } from "@/components/community/messages/thread-opener"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { RightPanel } from "@/components/community/shell/panel-types"
import type { ChannelMemberPanelProps } from "@/components/community/members/channel-member-view-model"

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
  parentChannelName,
  parentIsForum,
  childCreatorId,
  canRenameThread,
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
  onOpenChild,
  onOpenProfile,
  resolveUserName,
}: {
  channelId: string
  serverId: string
  serverParam: string
  channelName: string
  viewer: { id: string; name: string; avatar: string }
  anchorMessageId: string | null
  parentChannelId: string | null
  parentMessageId: string | null
  parentChannelName: string
  parentIsForum: boolean
  childCreatorId?: string | null
  canRenameThread: boolean
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
  onOpenChild: (childId: string) => void
  onOpenProfile: OpenProfile
  resolveUserName: (userId: string) => string
}) {
  const router = useRouter()
  const breakpoint = useBreakpoint()
  const [rightPanel, setRightPanel] = useState<RightPanel>(null)
  const [localName, setLocalName] = useState<string | null>(null)
  const { mutateAsync: editMessageAsync } = useEditMessage()
  const feed = useChannelMessageFeed({
    channelId,
    serverId,
    viewerUserId: viewer.id,
    isChildChannel: true,
    anchorMessageId,
  })
  const displayName = localName ?? channelName

  useEffect(() => {
    setRightPanel(null)
    setLocalName(null)
  }, [channelId])

  const togglePanel = useCallback((panel: Exclude<RightPanel, null>) => {
    setRightPanel((current) => current === panel ? null : panel)
  }, [])
  const openPinned = useCallback(() => setRightPanel("pinned"), [])
  const navigateBack = useCallback(() => {
    if (parentChannelId) {
      router.replace(`/c/channels/${serverParam}/${parentChannelId}`)
      return
    }
    onBack?.()
  }, [onBack, parentChannelId, router, serverParam])
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
        <ChannelHeaderSkeleton onBack={onBack} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MessageList key={channelId} channel="" messages={[]} loading onOpenThread={ignoreNestedThread} />
          <ComposerSkeleton />
        </main>
      </>
    )
  }

  const opener = parentMessageId && !parentIsForum ? (
    <ThreadOpener
      parentMessageId={parentMessageId}
      viewerUserId={viewer.id}
      onOpenProfile={onOpenProfile}
      onPreviewImage={(image) => uiHandlers.previewImage?.(image)}
      onPreviewAttachment={(attachment) => uiHandlers.previewAttachment?.(attachment)}
      onDownloadFile={(url, name) => {
        const link = document.createElement("a")
        link.href = url
        link.download = name
        link.click()
      }}
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
        <ChannelShell
          header={(
            <ChannelHeader
              channel={parentChannelName}
              forum={parentIsForum}
              rightPanel={rightPanel}
              onToggle={togglePanel}
              notifLevel={notificationLevel}
              onSetNotifLevel={onSetNotificationLevel}
              onBack={onBack}
              server={headerServer}
              tools={{ threads: false }}
              breadcrumb={{
                label: displayName,
                titleRename: parentIsForum,
                onNavigateBack: navigateBack,
                onRename: rename,
              }}
            />
          )}
          body={(
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
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
              <div data-onboarding-target="channel-composer" className="shrink-0">
                <Composer
                  channel={displayName}
                  context="thread"
                  members={composerMembers}
                  onSearchMembers={onSearchComposerMembers}
                  channelRefCandidates={channelRefCandidates}
                  sendContract="accepted"
                  onAcceptSend={controller.acceptMessage}
                  onTyping={controller.handleTyping}
                  replyingTo={controller.replyTo?.authorName}
                  onCancelReply={() => controller.setReplyTo(null)}
                  autoFocus={breakpoint === "desktop"}
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
      )}
    </MessageChannelController>
  )
}
