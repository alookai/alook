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
