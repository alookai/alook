"use client"

import type { NewForumThread } from "../messages/create-forum-thread"
import type { ForumThread } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"
import { ForumView } from "./forum-view"
import { useForumFeed } from "@/hooks/community/use-forum-feed"

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
    onEditPostTags={(threadId, tags) => {
      const post = feed.posts.find((candidate) => candidate.id === threadId)
      if (post) props.onEditPostTags?.(post, tags)
    }}
  />
}
