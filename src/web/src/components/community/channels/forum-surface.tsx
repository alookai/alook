"use client"

import { useQueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useRef } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store";

import type { NewForumThread } from "../messages/create-forum-thread"
import type { ComposerProps } from "../messages/composer"
import type { ForumThread } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"
import { ForumView } from "./forum-view"
import { useForumFeed } from "@/hooks/community/use-forum-feed"
import { useChannelReadStateSnapshot } from "@/hooks/community/use-channel-read-state"
import { useTimelineReadObserver } from "@/hooks/community/use-read-observer"
import { isConversationAccessError } from "@/lib/community/conversation-read"
import { ConversationResolutionErrorFrame } from "./conversation-resolution-error-frame"

export function ForumSurface({ serverId, forumChannelId, ...props }: {
  serverId: string
  forumChannelId: string
  members: Member[]
  mentionCandidates?: ComposerProps["mentionCandidates"]
  onOpenPost: (id: string) => void
  onCreatePost?: (post: NewForumThread) => Promise<void>
  onEditPostTags?: (post: ForumThread, tags: string[]) => Promise<void> | void
  canEditPostTags?: (post: ForumThread) => boolean
  savingTagsFor?: string | null
  onDeletePost?: (post: ForumThread) => void
  canDeletePost?: (post: ForumThread) => boolean
  deletingPost?: string | null
}) {
  const queryClient = useQueryClient()
  const feed = useForumFeed(serverId, forumChannelId)
  const readState = useChannelReadStateSnapshot(forumChannelId)
  const [scrollRootEl, setScrollRootEl] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const retryScope = JSON.stringify([forumChannelId, feed.tag])
  const [retryAttempt, setRetryAttempt] = useAtom(useCreateAtom<{ scope: string } | null>(null))
  const retryRef = useRef<{ scope: string } | null>(null)
  const retrying = retryAttempt?.scope === retryScope
  const accessError = isConversationAccessError(feed.error) || isConversationAccessError(readState.error)
  const initialLoadError = accessError || (feed.posts.length === 0 && (
    feed.isError || !!readState.error || retrying
  ))
  useTimelineReadObserver({
    channelId: forumChannelId,
    messages: feed.posts.flatMap((post) => (
      post.openerMessageId && post.parentSeq
        ? [{
            id: post.openerMessageId,
            seq: post.parentSeq,
            authorId: post.authorId,
            createdAt: post.openerCreatedAt,
          }]
        : []
    )),
    scrollRootEl,
    snapshotStatus: isConversationAccessError(readState.error)
      ? "error"
      : readState.isFetching
      ? "pending"
      : readState.snapshot
        ? "ready"
        : "error",
    feedStatus: feed.isPending
      ? "pending"
      : feed.isError
        ? "error"
        : "ready",
    tailAttached: true,
    confirmedSeq: readState.snapshot?.lastReadSeq ?? 0,
    catchUp: () => feed.refetch(),
  })
  if (initialLoadError) {
    return <ConversationResolutionErrorFrame as="div" retrying={retrying || feed.isFetching || readState.retrying} onRetry={() => {
      if (retrying || retryRef.current?.scope === retryScope || feed.isFetching || readState.retrying) return
      const attempt = { scope: retryScope }
      retryRef.current = attempt
      setRetryAttempt(attempt)
      void Promise.all([feed.refetch({ cancelRefetch: false }), queryClient.refetchQueries({ queryKey: communityKeys.channelReadStateSnapshot(forumChannelId), exact: true }, { cancelRefetch: false })]).finally(() => {
        if (retryRef.current === attempt) retryRef.current = null
        setRetryAttempt((current) => current === attempt ? null : current)
      })
    }} />
  }
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
    isFetching={feed.isFetching}
    isError={feed.isError}
    onLoadMore={feed.fetchOlder}
    onScrollRoot={setScrollRootEl}
    onEditPostTags={(threadId, tags) => {
      const post = feed.posts.find((candidate) => candidate.id === threadId)
      if (post) return props.onEditPostTags?.(post, tags)
    }}
  />
}
