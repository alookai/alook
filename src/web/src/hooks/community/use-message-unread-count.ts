"use client"

import { useMemo } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useSelector } from "@tanstack/react-store"
import { useChannelReadStateProjection } from "@/lib/community-db/projections"
import { resolveUnreadMessageCount } from "@/lib/community/message-read-projection"
import { getLocalReadingPosition, getReadCoordinator } from "./read-coordinator"

export function useMessageUnreadCount(input: {
  channelId: string | null
  viewerUserId: string
  messages: readonly { seq?: number }[]
  entryReadSeq: number | undefined
  latestSeq: number
  historyStartKnown: boolean
  hasMoreNewer: boolean
  ready: boolean
}) {
  const client = useQueryClient()
  const coordinator = useMemo(() => getReadCoordinator(client, input.viewerUserId), [client, input.viewerUserId])
  const localSeq = useSelector(coordinator.state, () => input.channelId ? getLocalReadingPosition(client, input.channelId)?.seq ?? 0 : 0)
  const { readState, hasSnapshot } = useChannelReadStateProjection(input.channelId)
  const confirmedSeq = readState?.lastReadSeq ?? (hasSnapshot ? 0 : input.entryReadSeq)
  return useMemo(() => !input.ready || confirmedSeq === undefined ? undefined : resolveUnreadMessageCount({
    messages: input.messages, latestSeq: input.latestSeq, historyStartKnown: input.historyStartKnown, hasMoreNewer: input.hasMoreNewer, lastReadSeq: Math.max(confirmedSeq, localSeq),
  }), [input.ready, input.messages, input.latestSeq, input.historyStartKnown, input.hasMoreNewer, confirmedSeq, localSeq])
}
