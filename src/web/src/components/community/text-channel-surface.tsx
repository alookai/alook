"use client"

import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"

export type TextChannelController = ReturnType<typeof useChannelMessageFeed> & {
  scrollTargetId: string | null
  setScrollTargetId: (targetId: string | null) => void
}

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
  const feed = useChannelMessageFeed({
    channelId,
    serverId,
    viewerUserId,
    isChildChannel: false,
    anchorMessageId,
  })
  const [scrollTargetId, setScrollTargetId] = useState<string | null>(anchorMessageId)
  const controller = useMemo(
    () => ({ ...feed, scrollTargetId, setScrollTargetId }),
    [feed, scrollTargetId],
  )
  useLayoutEffect(() => {
    onController?.(controller)
  }, [controller, onController])
  useEffect(() => {
    if (!scrollTargetId) return
    if (feed.messages.some((message) => message.id === scrollTargetId)) {
      const timeout = setTimeout(() => {
        setScrollTargetId((current) => (current === scrollTargetId ? null : current))
      }, 1600)
      return () => clearTimeout(timeout)
    }
    if (!feed.isLoading && !feed.isFetchingOlder && !feed.isFetchingNewer) {
      setScrollTargetId((current) => (current === scrollTargetId ? null : current))
    }
  }, [
    scrollTargetId,
    feed.messages,
    feed.isLoading,
    feed.isFetchingOlder,
    feed.isFetchingNewer,
  ])
  return children(controller)
}
