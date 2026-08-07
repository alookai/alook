"use client"

import { useMemo, useState } from "react"
import { useChannelReadStateSnapshot } from "./use-channel-read-state"
import { useChannelWatermark } from "./use-channel-watermark"
import { useEagerChannelRead } from "./use-eager-channel-read"
import { useMessages } from "./use-messages"
import { usePins, useThreads } from "./use-channel-panels"

export function useChannelMessageFeed({
  channelId,
  serverId,
  viewerUserId,
  isChildChannel,
  anchorMessageId,
}: {
  channelId: string | null
  serverId: string
  viewerUserId: string
  isChildChannel: boolean
  anchorMessageId: string | null
}) {
  const readState = useChannelReadStateSnapshot(channelId)
  const readSnapshot = readState.snapshot
  const messagesQuery = useMessages(channelId, {
    serverId,
    lastReadMessageId: readState.isFetching
      ? undefined
      : (readSnapshot?.lastReadMessageId ?? null),
    anchorMessageId,
  })
  const { newDividerBefore, anchorFound } = useMemo(() => {
    if (!readSnapshot) return { newDividerBefore: undefined, anchorFound: false }
    const lastId = readSnapshot.lastReadMessageId
    if (!lastId) {
      for (const message of messagesQuery.messages) {
        if (message.authorId !== viewerUserId) {
          return { newDividerBefore: message.id, anchorFound: true }
        }
      }
      return { newDividerBefore: undefined, anchorFound: true }
    }
    const index = messagesQuery.messages.findIndex((message) => message.id === lastId)
    if (index === -1) return { newDividerBefore: undefined, anchorFound: false }
    for (let i = index + 1; i < messagesQuery.messages.length; i++) {
      if (messagesQuery.messages[i].authorId !== viewerUserId) {
        return { newDividerBefore: messagesQuery.messages[i].id, anchorFound: true }
      }
    }
    return { newDividerBefore: undefined, anchorFound: true }
  }, [messagesQuery.messages, readSnapshot, viewerUserId])
  const [scrollRootEl, setScrollRootEl] = useState<HTMLDivElement | null>(null)
  useChannelWatermark({ channelId, messages: messagesQuery.messages, scrollRootEl })
  useEagerChannelRead({
    channelId,
    serverId,
    isChildChannel,
    snapshotReady: !readState.isFetching,
  })
  const unreadCount = useMemo(() => {
    const difference = messagesQuery.latestSeq - (readSnapshot?.lastReadSeq ?? 0)
    return Math.max(0, difference)
  }, [messagesQuery.latestSeq, readSnapshot])
  const threadsQuery = useThreads(channelId)
  const pinsQuery = usePins(channelId)

  return {
    ...messagesQuery,
    readSnapshot,
    readSnapshotFetching: readState.isFetching,
    newDividerBefore,
    anchorInCache: anchorFound,
    unreadCount,
    scrollRootEl,
    setScrollRootEl,
    threads: threadsQuery.threads,
    threadsLoading: threadsQuery.isLoading,
    pinned: pinsQuery.pins,
    pinnedLoading: pinsQuery.isLoading,
  }
}
