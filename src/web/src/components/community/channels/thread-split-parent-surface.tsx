"use client"

import { useConversationActivity } from "@/contexts/community/conversation-activity"
import { useLayoutEffect, useState, type ComponentProps } from "react"
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
import { useChannelMetadata } from "@/hooks/community/use-channel-metadata"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { communityWsClaimSecondaryChannel, communityWsReleaseSecondaryChannel } from "@/hooks/community/use-community-ws"

export function ThreadSplitParentSurface({
  serverId,
  serverParam,
  server,
  channel: hint,
  viewer,
  onNavigateParent,
  channelRefCandidates,
  uiHandlers,
  onOpenChild,
  onOpenProfile,
  onIdentity,
}: {
  serverId: string
  serverParam: string
  server: ServerDetail | null | undefined
  channel: Channel
  viewer: { id: string; name: string; discriminator?: string; avatar: string }
  onNavigateParent?: () => void
  channelRefCandidates: ComposerProps["channelRefCandidates"]
  uiHandlers: ComponentProps<typeof TextChannelSurface>["uiHandlers"]
  onOpenChild: (childId: string) => void
  onOpenProfile: OpenProfile
  onIdentity: (parentId: string, confirmed: boolean) => void
}) {
  const active = useConversationActivity()
  const metadata = useChannelMetadata(serverId, hint.id)
  const channel = metadata.data ? { ...hint, ...metadata.data } : hint
  const runtime = useCommunityRuntime()
  const [subscriptionOwner] = useState(() => Symbol("thread-split-secondary"))
  useLayoutEffect(() => {
    onIdentity(channel.id, metadata.identityKnown)
    return () => onIdentity(channel.id, false)
  }, [channel.id, metadata.identityKnown, onIdentity])
  useLayoutEffect(() => {
    if (active && metadata.canRead) communityWsClaimSecondaryChannel(runtime, subscriptionOwner, channel.id)
    else communityWsReleaseSecondaryChannel(runtime, subscriptionOwner)
    return () => {
      communityWsReleaseSecondaryChannel(runtime, subscriptionOwner)
    }
  }, [active, channel.id, metadata.canRead, runtime, subscriptionOwner])
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
    accessAllowed: active && metadata.canRead,
    roleDisplayAllowed: metadata.canRead,
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
