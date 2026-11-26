"use client"

import { useCallback, useMemo, useRef } from "react"
import type { ConversationListScope } from "@/lib/community/conversation-qualification"
import { useAtom, useCreateAtom } from "@tanstack/react-store";

import type { NewForumThread } from "../messages/create-forum-thread"
import type { ComposerProps } from "../messages/composer"
import type { ForumThread } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"
import { ForumView } from "./forum-view"
import { useForumFeed } from "@/hooks/community/use-forum-feed"
import { useConversationEntry } from "@/hooks/community/use-conversation-entry"
import { ConversationResourceProvider } from "@/hooks/community/conversation-resource-context"
import { useTimelineReadObserver } from "@/hooks/community/use-read-observer"
import { isConversationAccessError } from "@/lib/community/conversation-read"
import { ConversationResolutionErrorFrame } from "./conversation-resolution-error-frame"

type ForumSurfaceProps = {
  serverId: string
  forumChannelId: string
  routeTag?: string | null
  onSelectTag?: (tag: string) => void
  members: Member[]
  mentionCandidates?: ComposerProps["mentionCandidates"]
  onOpenPost: (id: string) => void
  onCreatePost?: (post: NewForumThread) => Promise<void>
  onEditPostTags?: (post: ForumThread, tags: string[]) => Promise<void> | void
  canEditPostTags?: (post: ForumThread) => boolean | undefined
  savingTagsFor?: string | null
  onDeletePost?: (post: ForumThread) => void
  canDeletePost?: (post: ForumThread) => boolean | undefined
  deletingPost?: string | null
}

export function ForumSurface({ serverId, forumChannelId, routeTag, onSelectTag, ...props }: ForumSurfaceProps) {
  const feed = useForumFeed(serverId, forumChannelId, { routeTag, onSelectTag })
  return (
    <ConversationResourceProvider value={feed.sharedResource}>
      <ForumSurfaceContent serverId={serverId} forumChannelId={forumChannelId} feed={feed} {...props} />
    </ConversationResourceProvider>
  )
}

function ForumSurfaceContent({
  serverId,
  forumChannelId,
  feed,
  ...props
}: Omit<ForumSurfaceProps, "routeTag" | "onSelectTag"> & {
  feed: ReturnType<typeof useForumFeed>
}) {
  const selectedTag = feed.tag === "All" ? null : feed.tag
  const entryTarget = useMemo(
    () => (feed.selectionReady ? { channelId: forumChannelId, serverId, tag: selectedTag } : null),
    [feed.selectionReady, forumChannelId, selectedTag, serverId],
  )
  const readState = useConversationEntry(entryTarget)
  const proof = readState.scope?.proof
  const positionScope = useMemo<ConversationListScope | undefined>(() => readState.canRead && proof
    ? { proof, tag: selectedTag } : undefined, [readState.canRead, proof, selectedTag])
  const [scrollRootEl, setScrollRootEl] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const retryScope = JSON.stringify([forumChannelId, feed.tag])
  const [retryAttempt, setRetryAttempt] = useAtom(useCreateAtom<{ scope: string } | null>(null))
  const retryRef = useRef<{ scope: string } | null>(null)
  const retrying = retryAttempt?.scope === retryScope
  const accessError = isConversationAccessError(feed.error) || isConversationAccessError(readState.error)
  const initialLoadError = accessError || (!feed.displayReady && (
    feed.isError || !!feed.initialLoadError || !!readState.error || retrying
  ))
  const readMessages = useMemo(
    () =>
      feed.posts.flatMap((post) => (
        post.openerMessageId && post.parentSeq
          ? [{
              id: post.openerMessageId,
              seq: post.parentSeq,
              authorId: post.authorId,
              createdAt: post.openerCreatedAt,
            }]
          : []
      )),
    [feed.posts],
  )
  const feedRefetch = feed.refetch
  const catchUp = useCallback(() => feedRefetch(), [feedRefetch])
  const retryTags = feed.retryTags
  const onRetryTags = useCallback(() => { void retryTags() }, [retryTags])
  const onEditPostTagsProp = props.onEditPostTags
  const onEditPostTags = useCallback((threadId: string, tags: string[]) => {
    const post = feed.posts.find((candidate) => candidate.id === threadId)
    if (post) return onEditPostTagsProp?.(post, tags)
  }, [feed.posts, onEditPostTagsProp])

  useTimelineReadObserver({
    channelId: forumChannelId,
    messages: readMessages,
    scrollRootEl,
    snapshotStatus: isConversationAccessError(readState.error)
      ? "error"
      : !readState.snapshot
      ? "pending"
      : "ready",
    feedStatus: feed.isPending
      ? "pending"
      : feed.isError
        ? "error"
        : "ready",
    tailAttached: true,
    confirmedSeq: readState.snapshot?.lastReadSeq ?? 0,
    catchUp,
  })
  if (initialLoadError) {
    return <ConversationResolutionErrorFrame as="div" retrying={retrying || feed.isFetching || readState.retrying} onRetry={() => {
      if (retrying || retryRef.current?.scope === retryScope || feed.isFetching || readState.retrying) return
      const attempt = { scope: retryScope }
      retryRef.current = attempt
      setRetryAttempt(attempt)
      void Promise.all([feed.refetch({ cancelRefetch: false }), readState.refetch({ cancelRefetch: false })]).finally(() => {
        if (retryRef.current === attempt) retryRef.current = null
        setRetryAttempt((current) => current === attempt ? null : current)
      })
    }} />
  }
  return <ForumView
    forumChannelId={forumChannelId}
    positionScope={positionScope}
    {...props}
    posts={feed.posts}
    loading={!feed.selectionReady || feed.isPending}
    tag={feed.selectionReady ? feed.tag : ""}
    availableTags={feed.availableTags}
    tagsKnown={feed.tagsKnown}
    tagsError={feed.tagsError}
    onRetryTags={onRetryTags}
    onTagChange={feed.selectTag}
    hasMore={feed.hasMoreOlder}
    loadingMore={feed.isFetchingOlder}
    isFetching={feed.isFetching}
    isError={feed.isError}
    onLoadMore={feed.fetchOlder}
    onScrollRoot={setScrollRootEl}
    onEditPostTags={onEditPostTags}
  />
}
