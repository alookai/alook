"use client"

import { useLayoutEffect, type ReactNode } from "react"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"

export type TextChannelController = ReturnType<typeof useChannelMessageFeed>

export function TextChannelSurface({
  channelId,
  serverId,
  viewerUserId,
  anchorMessageId,
  onController,
  children,
}: {
  channelId: string
  serverId: string
  viewerUserId: string
  anchorMessageId: string | null
  onController?: (controller: TextChannelController) => void
  children: (controller: TextChannelController) => ReactNode
}) {
  const controller = useChannelMessageFeed({
    channelId,
    serverId,
    viewerUserId,
    isChildChannel: false,
    anchorMessageId,
  })
  useLayoutEffect(() => {
    onController?.(controller)
  }, [controller, onController])
  return children(controller)
}
