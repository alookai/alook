import type { InfiniteData } from "@tanstack/react-query"
import type {
  CommunityReactionAdd,
  CommunityReactionRemove,
} from "@alook/shared"
import type { MessagesWindowPage, Msg } from "@/lib/community/models/message"

export type PageCache = InfiniteData<MessagesWindowPage>



export function removeThreadFromCache(
  cache: PageCache | undefined,
  threadId: string,
  openerMessageId?: string,
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((page) => {
    const messages = page.messages.filter((message) => (
      message.id !== openerMessageId
    ))
    if (messages.length === page.messages.length) return page
    touched = true
    return { ...page, messages }
  })
  return touched ? { ...cache, pages } : cache
}



export function applyReactionToMessage(
  message: Msg,
  event: CommunityReactionAdd | CommunityReactionRemove,
  viewerUserId: string | null,
): Msg {
  const reactions = (message.reactions ?? []).map((reaction) => ({
    ...reaction,
    userIds: [...(reaction.userIds ?? [])],
  }))
  if (event.type === "community:reaction.add") {
    const existing = reactions.find((reaction) => reaction.emoji === event.emoji)
    if (existing) {
      if (!existing.userIds.includes(event.userId)) existing.userIds.push(event.userId)
      existing.count = existing.userIds.length
      if (viewerUserId && event.userId === viewerUserId) existing.me = true
    } else {
      reactions.push({
        emoji: event.emoji,
        count: 1,
        me: !!viewerUserId && event.userId === viewerUserId,
        userIds: [event.userId],
      })
    }
  } else {
    const index = reactions.findIndex((reaction) => reaction.emoji === event.emoji)
    if (index !== -1) {
      reactions[index].userIds = reactions[index].userIds.filter((id) => id !== event.userId)
      reactions[index].count = reactions[index].userIds.length
      if (viewerUserId && event.userId === viewerUserId) reactions[index].me = false
      if (reactions[index].count <= 0) reactions.splice(index, 1)
    }
  }
  return { ...message, reactions }
}
