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
