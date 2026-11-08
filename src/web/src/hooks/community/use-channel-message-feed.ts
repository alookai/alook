"use client"

import { useConversationActivity } from "@/contexts/view-activity"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { isConversationAccessError } from "@/lib/community/conversation-read"
import { useMessageUnreadCount } from "./use-message-unread-count"
import { useTimelineReadObserver } from "./use-read-observer"
import { useMessages } from "./use-messages"
import { usePins, useThreads } from "./use-channel-panels"

export function useChannelMessageFeed({
  channelId,
  serverId,
  viewerUserId,
  anchorMessageId,
  threadsEnabled = false,
}: {
  channelId: string | null
  serverId: string
  viewerUserId: string
  anchorMessageId: string | null
  threadsEnabled?: boolean
}) {
  const active = useConversationActivity()
  const messagesQuery = useMessages(channelId, {
    serverId,
    anchorMessageId,
    viewerUserId,
  })
  const readSnapshot = messagesQuery.readSnapshot
  const newDividerBefore = messagesQuery.newBoundary?.target?.id
  const [scrollRootEl, setScrollRootEl] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  /* istanbul ignore next -- retained Chromium covers the mounted observer integration */
  useTimelineReadObserver({
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
  const unreadCount = useMessageUnreadCount({ channelId, viewerUserId, messages: messagesQuery.messages,
    entryReadSeq: readSnapshot?.lastReadSeq, latestSeq: messagesQuery.latestSeq,
    historyStartKnown: messagesQuery.historyStartKnown, hasMoreNewer: messagesQuery.hasMoreNewer,
    ready: !!readSnapshot && !messagesQuery.readSnapshotFetching && !messagesQuery.isPending && !messagesQuery.isError,
  })
  const threadsQuery = useThreads(channelId, threadsEnabled)
  const pinsQuery = usePins(channelId)
  return {
    ...messagesQuery,
    readSnapshot,
    newDividerBefore,
    unreadCount,
    scrollRootEl,
    setScrollRootEl,
    threads: threadsQuery.threads,
    threadsLoading: threadsQuery.isLoading,
    pinned: pinsQuery.pins,
    pinnedLoading: pinsQuery.isLoading || pinsQuery.canonicalPending,
  }
}
