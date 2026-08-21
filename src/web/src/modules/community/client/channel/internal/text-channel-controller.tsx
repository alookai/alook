"use client"

import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from "react"
import { useBreakpoint } from "@/hooks/use-mobile"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import type { ChannelMemberPanelProps } from "@/components/community/members/channel-member-view-model"
import type { FileAttachment, ImagePreview } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { RightPanel } from "@/components/community/shell/panel-types"
import type { ChannelNotifLevel } from "../channel-header"
import { Composer, MessageChannelController } from "../../messaging"
import { TextChannelView } from "./text-channel-view"

export type TextChannelControllerProps = {
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
}

export function TextChannelController(props: TextChannelControllerProps) {
  const breakpoint = useBreakpoint()
  const [rightPanel, setRightPanel] = useState<RightPanel>(null)
  const feed = useChannelMessageFeed({
    channelId: props.channelId,
    serverId: props.serverId,
    viewerUserId: props.viewer.id,
    isChildChannel: false,
    anchorMessageId: props.anchorMessageId,
  })
  useEffect(() => {
    setRightPanel(null)
  }, [props.channelId])
  const togglePanel = useCallback((panel: Exclude<RightPanel, null>) => {
    setRightPanel((current) => current === panel ? null : panel)
  }, [])
  const closePanel = useCallback(() => setRightPanel(null), [])
  const openPinned = useCallback(() => setRightPanel("pinned"), [])

  return (
    <MessageChannelController
      channelId={props.channelId}
      serverId={props.serverId}
      serverParam={props.serverParam}
      channelName={props.channelName}
      viewer={props.viewer}
      anchorMessageId={props.anchorMessageId}
      feed={feed}
      uiHandlers={props.uiHandlers}
      onOpenThread={props.onOpenThread}
      onOpenPinned={openPinned}
      resolveUserName={props.resolveUserName}
    >
      {(controller) => (
        <TextChannelView
          {...props}
          autoFocus={breakpoint === "desktop"}
          rightPanel={rightPanel}
          controller={controller}
          onTogglePanel={togglePanel}
          onClosePanel={closePanel}
        />
      )}
    </MessageChannelController>
  )
}
