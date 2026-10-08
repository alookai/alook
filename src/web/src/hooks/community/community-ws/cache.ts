import type { InfiniteData } from "@tanstack/react-query"
import type { MessagesWindowPage } from "@/lib/community/models/message"

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
