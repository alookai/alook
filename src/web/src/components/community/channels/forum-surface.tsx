"use client"

import { useState } from "react"
import type { NewForumThread } from "../messages/create-forum-thread"
import type { ForumThread } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"
import { ForumView } from "./forum-view"
import { useForumFeed } from "@/hooks/community/use-forum-feed"
import { useChannelReadStateSnapshot } from "@/hooks/community/use-channel-read-state"
import { useTimelineReadObserver } from "@/hooks/community/use-read-observer"

export function ForumSurface({ serverId, forumChannelId, ...props }: {
  serverId: string
  forumChannelId: string
  members: Member[]
  onSearchMembers?: (query: string) => void
  onOpenPost: (id: string) => void
  onCreatePost?: (post: NewForumThread) => Promise<void>
  onEditPostTags?: (post: ForumThread, tags: string[]) => void
  canEditPostTags?: (post: ForumThread) => boolean
  savingTagsFor?: string | null
  onDeletePost?: (post: ForumThread) => void
  canDeletePost?: (post: ForumThread) => boolean
  deletingPost?: string | null
}) {
  const feed = useForumFeed(serverId, forumChannelId)
  const readState = useChannelReadStateSnapshot(forumChannelId)
  const [scrollRootEl, setScrollRootEl] = useState<HTMLDivElement | null>(null)
  useTimelineReadObserver({
    channelId: forumChannelId,
    messages: feed.posts.flatMap((post) => (
      post.openerMessageId && post.parentSeq
        ? [{ id: post.openerMessageId, seq: post.parentSeq, authorId: post.authorId }]
        : []
    )),
    scrollRootEl,
    snapshotReady: !readState.isFetching,
    confirmedSeq: readState.snapshot?.lastReadSeq ?? 0,
  })
  return <ForumView
    forumChannelId={forumChannelId}
    {...props}
    posts={feed.posts}
    loading={feed.isLoading}
    tag={feed.tag}
    availableTags={feed.availableTags}
    onTagChange={feed.selectTag}
    hasMore={feed.hasMoreOlder}
    loadingMore={feed.isFetchingOlder}
    onLoadMore={feed.fetchOlder}
    onScrollRoot={setScrollRootEl}
    onEditPostTags={(threadId, tags) => {
      const post = feed.posts.find((candidate) => candidate.id === threadId)
      if (post) props.onEditPostTags?.(post, tags)
    }}
  />
}
