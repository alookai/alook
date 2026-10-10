"use client"

import type { ComponentProps } from "react"
import { canManageServer, isForum, USE_SERVER_DEFAULT } from "@alook/shared"
import { toastApiError } from "@/lib/api/client"
import type { Channel } from "@/lib/community/models/navigation"
import type { ServerDetail } from "@/hooks/community/use-servers"
import { useNotificationSettings } from "@/hooks/community/use-notification-settings"
import { useSetChannelNotif } from "@/hooks/community/mutations"
import { useChannelMemberViewModel } from "@/components/community/members/channel-member-view-model"
import type { ComposerProps } from "@/components/community/messages/composer"
import type { OpenProfile } from "@/components/community/social/profile-types"
import { ForumChannelSurface } from "@/components/community/channels/forum-channel-surface"
import { TextChannelSurface } from "@/components/community/channels/text-channel-surface"
import type { ChannelNotifLevel } from "@/components/community/channels/channel-header"
import { ChannelHeaderSkeleton } from "@/components/community/channels/channel-header"
import { ConversationMessageSkeleton } from "@/components/community/channels/conversation-message-skeleton"
import { ForumViewSkeleton } from "@/components/community/channels/forum-view"
import { ConversationResolutionErrorFrame } from "@/components/community/channels/conversation-resolution-error-frame"
import type { useChannelMetadata } from "@/hooks/community/use-channel-metadata"

export function ThreadSplitParentSurface({
  serverId,
  serverParam,
  server,
  channel,
  viewer,
  metadata,
  onNavigateParent,
  channelRefCandidates,
  uiHandlers,
  onOpenChild,
  onOpenProfile,
}: {
  serverId: string
  serverParam: string
  server: ServerDetail
  channel: Channel
  viewer: { id: string; name: string; discriminator?: string; avatar: string }
  metadata: ReturnType<typeof useChannelMetadata>
  onNavigateParent?: () => void
  channelRefCandidates: ComposerProps["channelRefCandidates"]
  uiHandlers: ComponentProps<typeof TextChannelSurface>["uiHandlers"]
  onOpenChild: (childId: string) => void
  onOpenProfile: OpenProfile
}) {
  const members = useChannelMemberViewModel({
    serverId,
    channelId: channel.id,
    channelName: channel.name,
    currentServer: server,
    channelInServer: channel,
    currentChannelMeta: null,
    isChildChannel: false,
    isNotifyUnit: false,
    currentUser: viewer,
    accessAllowed: metadata.canRead,
  })
  const notifs = useNotificationSettings()
  const { mutate: setChannelNotif } = useSetChannelNotif()
  const notificationLevel = (notifs.channel[channel.id] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT
  const setNotificationLevel = (level: ChannelNotifLevel) => {
    setChannelNotif({ channelId: channel.id, level }, {
      onError: (error) => toastApiError(error, "Failed to update notification level"),
    })
  }

  if (!metadata.canRead) {
    if (metadata.status === "retryable-error") return <ConversationResolutionErrorFrame
      retrying={metadata.retrying} onRetry={() => { void metadata.retry() }} />
    return <>
      <ChannelHeaderSkeleton kind={isForum(channel.type) ? "forum" : "text"} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isForum(channel.type) ? <ForumViewSkeleton /> : <ConversationMessageSkeleton />}
      </main>
    </>
  }

  if (isForum(channel.type)) {
    return (
      <ForumChannelSurface
        serverId={serverId}
        channelId={channel.id}
        channelName={channel.name}
        viewer={viewer}
        viewerRole={members.myRole}
        onNavigateParent={onNavigateParent}
        notificationLevel={notificationLevel}
        onSetNotificationLevel={setNotificationLevel}
        composerMembers={members.composerMembers}
        composerMentionCandidates={members.composerMentionCandidates}
        memberPanelProps={members.memberPanelProps}
        manageMembersDialog={members.manageMembersDialog}
        onOpenPost={onOpenChild}
        onOpenProfile={onOpenProfile}
        embedded
      />
    )
  }

  return (
    <TextChannelSurface
      channelId={channel.id}
      serverId={serverId}
      serverParam={serverParam}
      channelName={channel.name}
      viewer={viewer}
      canManagePins={canManageServer(members.myRole)}
      anchorMessageId={null}
      onNavigateParent={onNavigateParent}
      notificationLevel={notificationLevel}
      onSetNotificationLevel={setNotificationLevel}
      composerMembers={members.composerMembers}
      composerMentionCandidates={members.composerMentionCandidates}
      channelRefCandidates={channelRefCandidates}
      memberPanelProps={members.memberPanelProps}
      manageMembersDialog={members.manageMembersDialog}
      uiHandlers={uiHandlers}
      onOpenThread={onOpenChild}
      onOpenProfile={onOpenProfile}
      resolveUserName={members.resolveUserName}
      embedded
    />
  )
}
