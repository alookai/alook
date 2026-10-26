type ProjectionMessage = {
  id: string
  authorId?: string | null
}

export type MessageReadProjection = {
  newDividerBefore: string | undefined
  anchorFound: boolean
}

export function resolveMessageReadProjection({
  messages,
  lastReadMessageId,
  viewerUserId,
  anchorReconciled,
}: {
  messages: ProjectionMessage[]
  lastReadMessageId: string | null
  viewerUserId: string
  anchorReconciled: boolean
}): MessageReadProjection {
  if (!lastReadMessageId) {
    if (messages.length === 0 && !anchorReconciled) {
      return { newDividerBefore: undefined, anchorFound: false }
    }
    const firstUnread = messages.find((message) => message.authorId !== viewerUserId)
    return { newDividerBefore: firstUnread?.id, anchorFound: true }
  }

  const anchorIndex = messages.findIndex((message) => message.id === lastReadMessageId)
  if (anchorIndex === -1) {
    return { newDividerBefore: undefined, anchorFound: false }
  }
  const firstUnread = messages
    .slice(anchorIndex + 1)
    .find((message) => message.authorId !== viewerUserId)
  return { newDividerBefore: firstUnread?.id, anchorFound: true }
}

export function resolveUnreadMessageCount({ messages, lastReadSeq, latestSeq, historyStartKnown, hasMoreNewer }: {
  messages: readonly { seq?: number }[]
  lastReadSeq: number
  latestSeq: number
  historyStartKnown: boolean
  hasMoreNewer: boolean
}): number | undefined {
  if (latestSeq <= lastReadSeq) return 0
  if (hasMoreNewer || messages.some(message => message.seq === undefined)) return undefined
  if (!historyStartKnown && !messages.some(message => message.seq! <= lastReadSeq)) return undefined
  const seqs = new Set(messages.flatMap(message => message.seq! > lastReadSeq ? [message.seq!] : []))
  if (!seqs.has(latestSeq)) return undefined
  return seqs.size
}
