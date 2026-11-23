"use client"

import { useMemo } from "react"
import { useInboxChannelMessages } from "@/hooks/community/use-inbox-channel-messages"
import { useCanonicalChannelsById, useCanonicalMessagesById, useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { projectForumThread } from "@/lib/community/forum-feed-window"
import type { InboxUnreadMessagesInput } from "@/lib/community/models/inbox"
import { flattenMessageItems, MESSAGE_GROUPED_ROW_PADDING_PX } from "@/lib/community/message-list-items"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { ForumPostItem } from "../channels/forum-post-item"
import { ForumPostListItem } from "../channels/forum-post-list"
import { InboxMessagePreview } from "./inbox-message-preview"

export function InboxUnreadMessages({
  channelId,
  throughSeq,
  mentions,
  openForumPosts,
  continuation,
  viewerUserId,
  onSubmitDecisionCard,
}: InboxUnreadMessagesInput) {
  const query = useInboxChannelMessages(channelId, throughSeq)
  const channels = useCanonicalChannelsById()
  const profiles = useCanonicalProfilesByUserId()
  const mentionById = new Map(mentions.map(mention => [mention.m.id, mention]))
  const messages = useMemo(() => [...new Map([...query.messages, ...mentions.map(mention => mention.m)].map(message => [message.id, message])).values()]
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0)), [mentions, query.messages])
  const previewIds = useMemo(() => messages.flatMap(message => {
    if (!openForumPosts?.has(message.id) || !message.thread) return []
    const firstMessageId = channels.get(message.thread.id)?.firstMessageId
    return firstMessageId ? [firstMessageId] : []
  }), [channels, messages, openForumPosts])
  const previewMessages = useCanonicalMessagesById(previewIds)
  const lastMessageId = messages.at(-1)?.id
  if (!query.accessAllowed) return <p className="py-1.5 text-sm text-muted-foreground">This conversation is unavailable</p>
  return <div className="flex flex-col gap-1" data-testid={tid.inboxUnreadMessages(channelId)}>
    {query.loading && messages.length === 0 && <div role="status" aria-label="Loading unread messages" className="flex items-start gap-2 py-2">
      {continuation
        ? <div className="w-8 shrink-0" />
        : <Skeleton className="size-8 shrink-0 rounded-full" />}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {!continuation && <Skeleton className="h-3 w-24 rounded" />}
        <Skeleton className="h-3.5 w-3/4 rounded" />
        <Skeleton className="h-3.5 w-full rounded" />
      </div>
    </div>}
    {messages.length > 0 && <div data-slot="inbox-card-messages" className={cn("flex min-w-0 flex-col", !continuation && "gap-1")}>
      {flattenMessageItems(messages, undefined, false, false, false).map((item, index) => {
        if (item.kind !== "message") return null
        const mention = mentionById.get(item.m.id)
        const openForumPost = openForumPosts?.get(item.m.id)
        const postChannel = openForumPost && item.m.thread ? channels.get(item.m.thread.id) : undefined
        if (openForumPost && postChannel?.parentChannelId === channelId && postChannel.parentMessageId === item.m.id) {
          const first = postChannel.firstMessageId ? previewMessages?.get(postChannel.firstMessageId) : undefined
          const post = projectForumThread(postChannel, item.m, first, item.m.thread?.participants)
          return <div key={item.key} className={cn("-mx-1", item.m.id === lastMessageId && "pb-1")}
            data-testid={mention ? tid.inboxMention(mention.id) : undefined}
            onClick={event => event.stopPropagation()}>
            <ForumPostListItem first={index === 0} onActivate={openForumPost}>
              <ForumPostItem post={post} profilesByUserId={profiles} onOpen={openForumPost} />
            </ForumPostListItem>
          </div>
        }
        return <InboxMessagePreview key={item.key} message={item.m} continuation={continuation}
          first={index === 0}
          testId={mention ? tid.inboxMention(mention.id) : undefined}
          onOpenThread={openForumPost}
          viewerUserId={viewerUserId}
          onSubmitDecisionCard={onSubmitDecisionCard
            ? (messageId, content, nonce) => onSubmitDecisionCard(channelId, messageId, content, nonce)
            : undefined}
          paddingTop={item.paddingTop}
          paddingBottom={continuation && item.m.id !== lastMessageId ? MESSAGE_GROUPED_ROW_PADDING_PX : item.paddingBottom} />
      })}
    </div>}
    {query.empty && messages.length === 0 && <p className="py-1.5 text-sm text-muted-foreground">No unread messages</p>}
  </div>
}
