import type { InfiniteData } from "@tanstack/react-query"
import type {
  CommunityReactionAdd,
  CommunityReactionRemove,
} from "@alook/shared"
import type { MessagesPage, Msg } from "@/lib/community/models/message"

export type PageCache = InfiniteData<MessagesPage>

/**
 * Patch every cached message authored by `userId` to the renamed
 * `authorName` — `authorName` is a snapshot field written at send time
 * (`communityMessage` doesn't store it; the live JOIN is `message.ts`'s
 * `authorName: user.name`), so nothing else updates already-loaded message
 * rows after a self-rename. Only touches rows that are actually cached in
 * this client (open/previously-open channels & DMs) — a channel never
 * loaded this session picks up the new name for free on its first real
 * fetch, since that IS the live JOIN.
 */
export function patchAuthorNameInCache(cache: PageCache | undefined, userId: string, newName: string): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.authorId === userId)) return p
    touched = true
    return {
      ...p,
      messages: p.messages.map((m) => (m.authorId === userId ? { ...m, authorName: newName } : m)),
    }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

/**
 * Patch the `approval` payload of a single cached message — the client-side
 * effect of a `MESSAGE_UPDATED` event. The card re-renders in its new
 * state (approved/denied/superseded/waiting) without a refetch.
 */
export function patchApprovalInCache(
  cache: PageCache | undefined,
  messageId: string,
  approval: Msg["approval"],
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.id === messageId)) return p
    touched = true
    return {
      ...p,
      messages: p.messages.map((m) => (m.id === messageId ? { ...m, approval } : m)),
    }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

export function patchMessageContentInCache(cache: PageCache | undefined, messageId: string, content: string): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((page) => ({
    ...page,
    messages: page.messages.map((message) => {
      if (message.id !== messageId) return message
      touched = true
      return { ...message, content }
    }),
  }))
  return touched ? { ...cache, pages } : cache
}

export function removeThreadFromCache(
  cache: PageCache | undefined,
  threadId: string,
  openerMessageId?: string,
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((page) => {
    const messages = page.messages.filter((message) => (
      message.thread?.id !== threadId && message.id !== openerMessageId
    ))
    if (messages.length === page.messages.length) return page
    touched = true
    return { ...page, messages }
  })
  return touched ? { ...cache, pages } : cache
}

export function applyReactionToCache(
  cache: PageCache | undefined,
  event: CommunityReactionAdd | CommunityReactionRemove,
  viewerUserId: string | null,
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.id === event.messageId)) return p
    touched = true
    return {
      ...p,
      messages: p.messages.map((message) =>
        message.id === event.messageId
          ? applyReactionToMessage(message, event, viewerUserId)
          : message),
    }
  })
  if (!touched) return cache
  return { ...cache, pages }
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

export function findCachedMessage(cache: PageCache | undefined, messageId: string): Msg | undefined {
  for (const page of cache?.pages ?? []) {
    const message = page.messages.find((row) => row.id === messageId)
    if (message) return message
  }
  return undefined
}
