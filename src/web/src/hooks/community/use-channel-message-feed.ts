"use client"

import { useMemo, useState } from "react"
import { useChannelReadStateSnapshot } from "./use-channel-read-state"
import { useChannelWatermark } from "./use-channel-watermark"
import { useMessages } from "./use-messages"
import { usePins, useThreads } from "./use-channel-panels"
import { resolveMessageReadProjection } from "@/lib/community/message-read-projection"
import { useReadStateProjection } from "@/lib/community-db/projections"

export function useChannelMessageFeed({
  channelId,
  serverId,
  viewerUserId,
  isChildChannel: _isChildChannel,
  anchorMessageId,
}: {
  channelId: string | null
  serverId: string
  viewerUserId: string
  isChildChannel: boolean
  anchorMessageId: string | null
}) {
  const canonicalReadSnapshot = useReadStateProjection(channelId)
  const readState = useChannelReadStateSnapshot(channelId, canonicalReadSnapshot)
  const readSnapshot = readState.snapshot
  const messagesQuery = useMessages(channelId, {
    serverId,
    lastReadMessageId: readState.isFetching
      ? undefined
      : (readSnapshot?.lastReadMessageId ?? null),
    anchorMessageId,
    // Ordinary direct/sidebar mounts keep the established anchor-first
    // contract. Inbox clicks get their independent newest/read/detail
    // concurrency from startConversationNavigationWarmup before this route
    // mounts; widening the route hook itself to newest-first changes every
    // navigation source and can replace the read-centered window.
    waitForAnchor: true,
    reconcileLateAnchor: true,
    revalidateOnMount: true,
    viewerUserId,
  })
  const { newDividerBefore, anchorFound } = useMemo(() => {
    if (!readSnapshot) return { newDividerBefore: undefined, anchorFound: false }
    return resolveMessageReadProjection({
      messages: messagesQuery.messages,
      lastReadMessageId: readSnapshot.lastReadMessageId,
      viewerUserId,
      anchorReconciled: messagesQuery.anchorReconciled,
    })
  }, [messagesQuery.anchorReconciled, messagesQuery.messages, readSnapshot, viewerUserId])
  const [scrollRootEl, setScrollRootEl] = useState<HTMLDivElement | null>(null)
  /* istanbul ignore next -- retained Chromium covers the mounted observer integration */
  useChannelWatermark({
    channelId,
    messages: messagesQuery.messages,
    scrollRootEl,
    snapshotStatus: readState.isFetching
      ? "pending"
      : readSnapshot
        ? "ready"
        : "error",
    feedStatus: messagesQuery.isPending
      ? "pending"
      : messagesQuery.isError
        ? "error"
        : "ready",
    tailAttached: !messagesQuery.hasMoreNewer,
    confirmedSeq: readSnapshot?.lastReadSeq ?? 0,
    catchUp: () => messagesQuery.refetch(),
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
