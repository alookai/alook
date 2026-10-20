"use client"

import { useConversationActivity } from "@/contexts/community/conversation-activity"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useMemo } from "react"
import { isConversationAccessError } from "@/lib/community/conversation-read"
import { useChannelWatermark } from "./use-channel-watermark"
import { useMessages } from "./use-messages"
import { usePins, useThreads } from "./use-channel-panels"
import { resolveMessageReadProjection } from "@/lib/community/message-read-projection"

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
  const active = useConversationActivity()
  const messagesQuery = useMessages(channelId, {
    serverId,
    anchorMessageId,
    viewerUserId,
  })
  const readSnapshot = messagesQuery.readSnapshot
  const { newDividerBefore, anchorFound } = useMemo(() => {
    if (!readSnapshot) return { newDividerBefore: undefined, anchorFound: false }
    return resolveMessageReadProjection({
      messages: messagesQuery.messages,
      lastReadMessageId: readSnapshot.lastReadMessageId,
      viewerUserId,
      anchorReconciled: messagesQuery.anchorReconciled,
    })
  }, [messagesQuery.anchorReconciled, messagesQuery.messages, readSnapshot, viewerUserId])
  const [scrollRootEl, setScrollRootEl] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  /* istanbul ignore next -- retained Chromium covers the mounted observer integration */
  useChannelWatermark({
    channelId: active ? channelId : null,
    messages: messagesQuery.messages,
    scrollRootEl,
    snapshotStatus: messagesQuery.entryDenied || isConversationAccessError(messagesQuery.initialLoadError)
      ? "error"
      : messagesQuery.readSnapshotFetching
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
    newDividerBefore,
    anchorInCache: anchorFound || messagesQuery.initialPositionKnown,
    unreadCount,
    scrollRootEl,
    setScrollRootEl,
    threads: threadsQuery.threads,
    threadsLoading: threadsQuery.isLoading,
    pinned: pinsQuery.pins,
    pinnedLoading: pinsQuery.isLoading || pinsQuery.canonicalPending,
  }
}
