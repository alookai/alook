"use client"

import { useInboxChannelMessages } from "@/hooks/community/use-inbox-channel-messages"
import type { InboxUnreadMessagesInput } from "@/lib/community/models/inbox"
import { flattenMessageItems, MESSAGE_GROUPED_ROW_PADDING_PX } from "@/lib/community/message-list-items"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { InboxMessagePreview } from "./inbox-message-preview"

export function InboxUnreadMessages({ channelId, throughSeq, mentions, openForumPosts, continuation }: InboxUnreadMessagesInput) {
  const query = useInboxChannelMessages(channelId, throughSeq)
  const mentionById = new Map(mentions.map(mention => [mention.m.id, mention]))
  const messages = [...new Map([...query.messages, ...mentions.map(mention => mention.m)].map(message => [message.id, message])).values()]
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
  const lastMessageId = messages.at(-1)?.id
  if (!query.accessAllowed) return <p className="p-2 text-sm text-muted-foreground">This conversation is unavailable</p>
  return <div className="flex flex-col gap-2" data-testid={tid.inboxUnreadMessages(channelId)}>
    {query.loading && messages.length === 0 && <div role="status" aria-label="Loading unread messages" className="flex flex-col gap-2 py-2">
      <Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-full" />
    </div>}
    {messages.length > 0 && <div data-slot="inbox-card-messages" className={cn("flex min-w-0 flex-col", !continuation && "gap-2")}>
      {flattenMessageItems(messages, undefined, false, false, false).map(item => {
        if (item.kind !== "message") return null
        const mention = mentionById.get(item.m.id)
        const openForumPost = openForumPosts?.get(item.m.id)
        return <InboxMessagePreview key={item.key} message={item.m} continuation={continuation}
          testId={mention ? tid.inboxMention(mention.id) : undefined}
          onOpenThread={openForumPost}
          paddingTop={item.paddingTop}
          paddingBottom={continuation && item.m.id !== lastMessageId ? MESSAGE_GROUPED_ROW_PADDING_PX : item.paddingBottom} />
      })}
    </div>}
    {query.empty && messages.length === 0 && <p className="p-2 text-sm text-muted-foreground">No unread messages</p>}
  </div>
}
