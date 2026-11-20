"use client"

import { useInboxChannelMessages } from "@/hooks/community/use-inbox-channel-messages"
import type { InboxUnreadMessagesInput, Mention } from "@/lib/community/models/inbox"
import { flattenMessageItems } from "@/lib/community/message-list-items"
import { tid } from "@/lib/community/testids"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { InboxMessagePreview } from "./inbox-message-preview"

export function InboxUnreadMessages({ channelId, throughSeq, mentions, openForumPosts, onOpenMention }: InboxUnreadMessagesInput & {
  onOpenMention?: (mention: Mention) => void
}) {
  const query = useInboxChannelMessages(channelId, throughSeq)
  const mentionById = new Map(mentions.map(mention => [mention.m.id, mention]))
  const messages = [...new Map([...query.messages, ...mentions.map(mention => mention.m)].map(message => [message.id, message])).values()]
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
  if (!query.accessAllowed) return <p className="p-2 text-sm text-muted-foreground">This conversation is unavailable</p>
  return <div className="flex flex-col gap-2" data-testid={tid.inboxUnreadMessages(channelId)}>
    {query.loading && !query.isError && messages.length === 0 && <div role="status" aria-label="Loading unread messages" className="flex flex-col gap-2">
      <Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-full" />
    </div>}
    {flattenMessageItems(messages, undefined, false, false, false).map(item => {
      if (item.kind !== "message") return null
      const mention = mentionById.get(item.m.id)
      const openForumPost = openForumPosts?.get(item.m.id)
      return <InboxMessagePreview key={item.key} message={item.m}
        testId={mention ? tid.inboxMention(mention.id) : undefined}
        onOpen={mention && onOpenMention ? () => onOpenMention(mention) : openForumPost}
        onOpenThread={openForumPost}
        paddingTop={item.paddingTop} paddingBottom={item.paddingBottom} />
    })}
    {query.isError && <div role="alert" className="flex items-center justify-between gap-2 text-sm">
      <span>Couldn&apos;t load unread messages</span>
      <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={query.isFetching} onClick={() => { void query.refetch() }}>Retry</Button>
    </div>}
    {!query.loading && !query.isError && messages.length === 0 && <p className="p-2 text-sm text-muted-foreground">No unread messages</p>}
  </div>
}
