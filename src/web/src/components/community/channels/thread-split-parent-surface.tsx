"use client"

import type { ComponentProps } from "react"
import { isForum, USE_SERVER_DEFAULT } from "@alook/shared"
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

export function ThreadSplitParentSurface({
  serverId,
  serverParam,
  server,
  channel,
  viewer,
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
  })
  const notifs = useNotificationSettings()
  const { mutate: setChannelNotif } = useSetChannelNotif()
  const notificationLevel = (notifs.channel[channel.id] as ChannelNotifLevel) ?? USE_SERVER_DEFAULT
  const setNotificationLevel = (level: ChannelNotifLevel) => {
    setChannelNotif({ channelId: channel.id, level }, {
      onError: (error) => toastApiError(error, "Failed to update notification level"),
    })
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
