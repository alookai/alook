"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"

export type TextChannelController = ReturnType<typeof useChannelMessageFeed> & {
  scrollTargetId: string | null
  setScrollTargetId: (targetId: string | null) => void
  consumeScrollTarget: (targetId: string) => void
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
  const consumeScrollTarget = useCallback((targetId: string) => {
    setScrollTargetId((current) => (current === targetId ? null : current))
  }, [])
  const controller = useMemo(
    () => ({ ...feed, scrollTargetId, setScrollTargetId, consumeScrollTarget }),
    [feed, scrollTargetId, consumeScrollTarget],
  )
  useLayoutEffect(() => {
    onController?.(controller)
  }, [controller, onController])
  useEffect(() => {
    if (!scrollTargetId) return
    if (feed.messages.some((message) => message.id === scrollTargetId)) return
    if (feed.isError) {
      setScrollTargetId((current) => (current === scrollTargetId ? null : current))
    }
  }, [
    scrollTargetId,
    feed.messages,
    feed.isError,
  ])
  return children(controller)
}
