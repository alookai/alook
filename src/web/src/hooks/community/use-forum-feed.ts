"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query"
import { compareAsciiSqliteBinary, DEFAULT_MESSAGE_PAGE_SIZE } from "@alook/shared"
import { apiFetchProfiles } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { canonicalUserImage } from "@/lib/community/storage"
import { readForumTagSelection, validateForumTagSelection, writeForumTagSelection } from "@/lib/community/forum-tag-selection"
import type { ForumThread } from "@/lib/community/models/message"
import { useForumTags } from "./use-channel-panels"
import {
  projectForumThreadsThroughActiveTagTransitions,
  type ForumFeedPage,
} from "./forum-feed-tag-transition"

export { removeForumPostFromFeed } from "./forum-feed-tag-transition"
export type { ForumFeedPage } from "./forum-feed-tag-transition"

export function forumFeedPageQueryFn(channelId: string, tag: string | null) {
  return ({ pageParam, signal }: { pageParam: string | null; signal?: AbortSignal }) => {
    const params = new URLSearchParams({
      order: "createdAt",
      limit: String(DEFAULT_MESSAGE_PAGE_SIZE),
      include: "parentMessage,firstMessage,tags,participants",
    })
    if (tag) params.set("tag", tag)
    if (pageParam) params.set("cursor", pageParam)
    return apiFetchProfiles<ForumFeedPage>(
      `/api/community/channels/${channelId}/threads?${params.toString()}`,
      (page) => [
        ...page.included.parentMessages.map((message) => ({
          id: message.authorId,
          identityAbout: { name: message.authorName },
          avatar: {
            avatar: canonicalUserImage(
              message.authorId,
              message.authorImage,
              message.authorAvatarVersion,
            ) ?? avatarInitial(message.authorName),
            avatarVersion: message.authorAvatarVersion,
          },
        })),
        ...page.included.participants.map((participant) => ({
          id: participant.userId,
          ...(participant.userName !== null
            ? { identityAbout: { name: participant.userName } }
            : {}),
          avatar: {
            avatar: canonicalUserImage(
              participant.userId,
              participant.userImage,
              participant.userAvatarVersion,
            ) ?? avatarInitial(participant.userName ?? "Unknown"),
            avatarVersion: participant.userAvatarVersion,
          },
        })),
      ],
      signal ? { signal } : undefined,
    )
  }
}

export function mapForumFeedPages(pages: ForumFeedPage[]): ForumThread[] {
  const byId = new Map<string, ForumThread>()
  const createdAtById = new Map<string, string>()
  for (const page of pages) {
    const openerById = new Map(page.included.parentMessages.map((message) => [message.id, message]))
    const firstByChannel = new Map(page.included.firstMessages.map((message) => [message.channelId, message]))
    const tagsByMessage = new Map<string, string[]>()
    for (const row of page.included.tags) {
      tagsByMessage.set(row.messageId, [...(tagsByMessage.get(row.messageId) ?? []), row.tag])
    }
    const participantsByChannel = new Map<string, ForumThread["participants"]>()
    const participantCountByChannel = new Map<string, number>()
    for (const row of page.included.participants) {
      participantsByChannel.set(row.channelId, [
        ...(participantsByChannel.get(row.channelId) ?? []),
        {
          id: row.userId,
          name: row.userName ?? "",
          avatar: canonicalUserImage(row.userId, row.userImage, row.userAvatarVersion)
            ?? avatarInitial(row.userName ?? ""),
          avatarVersion: row.userAvatarVersion,
        },
      ])
      participantCountByChannel.set(row.channelId, Number(row.participantCount ?? 0))
    }

    for (const thread of page.threads) {
      if (byId.has(thread.id)) continue
      createdAtById.set(thread.id, thread.createdAt)
      const opener = thread.parentMessageId ? openerById.get(thread.parentMessageId) : undefined
      const first = firstByChannel.get(thread.id)
      byId.set(thread.id, {
        id: thread.id,
        name: opener?.content.trim() ? opener.content : thread.name?.trim() || "Post",
        messageCount: thread.messageCount ?? 0,
        lastMessageAt: thread.activityAt,
        parent: {
          authorId: opener?.authorId,
          authorName: opener?.authorName ?? "",
          text: (first?.content ?? "").slice(0, 100),
        },
        authorId: opener?.authorId ?? thread.creatorId ?? "",
        authorAvatar: opener
          ? canonicalUserImage(opener.authorId, opener.authorImage, opener.authorAvatarVersion)
            ?? avatarInitial(opener.authorName)
          : avatarInitial(""),
        authorAvatarVersion: opener?.authorAvatarVersion ?? 0,
        openerMessageId: thread.parentMessageId ?? "",
        ...(opener?.createdAt ? { openerCreatedAt: opener.createdAt } : {}),
        ...(opener ? { parentSeq: opener.seq } : {}),
        tags: thread.parentMessageId ? tagsByMessage.get(thread.parentMessageId) ?? [] : [],
        preview: (first?.content ?? "").slice(0, 100),
        participants: participantsByChannel.get(thread.id) ?? [],
        participantCount: participantCountByChannel.get(thread.id) ?? 0,
      })
    }
  }
  return [...byId.values()].sort((a, b) => {
    const createdAt = compareAsciiSqliteBinary(createdAtById.get(b.id)!, createdAtById.get(a.id)!)
    return createdAt || compareAsciiSqliteBinary(b.id, a.id)
  })
}

export function useForumFeed(_serverId: string, channelId: string) {
  const queryClient = useQueryClient()
  const [tag, setTag] = useState(() => {
    if (typeof window === "undefined") return "All"
    try { return readForumTagSelection(window.localStorage, channelId) }
    catch { return "All" }
  })
  const tagsQuery = useForumTags(channelId, true)
  useEffect(() => {
    if (!tagsQuery.isSuccess || tag === "All") return
    if (validateForumTagSelection(tag, tagsQuery.data.tags) !== "All") return
    setTag("All")
    try { writeForumTagSelection(window.localStorage, channelId, "All") } catch { }
  }, [channelId, tag, tagsQuery.data, tagsQuery.isSuccess])
  const selectTag = useCallback((next: string) => {
    setTag(next)
    try { writeForumTagSelection(window.localStorage, channelId, next) } catch { }
  }, [channelId])
  const selectedTag = tag === "All" ? null : tag
  const queryKey = communityKeys.forumFeed(channelId, selectedTag)
  const query = useInfiniteQuery<
    ForumFeedPage,
    Error,
    InfiniteData<ForumFeedPage, string | null>,
    typeof queryKey,
    string | null
  >({
    queryKey,
    queryFn: forumFeedPageQueryFn(channelId, selectedTag),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
  })
  const posts = useMemo(
    () => projectForumThreadsThroughActiveTagTransitions(
      queryClient,
      channelId,
      selectedTag,
      mapForumFeedPages(query.data?.pages ?? []),
    ),
    [channelId, query.data?.pages, queryClient, selectedTag],
  )

  return {
    ...query,
    posts,
    tag,
    selectTag,
    availableTags: tagsQuery.data?.tags ?? [],
    hasMoreOlder: query.hasNextPage,
    isFetchingOlder: query.isFetchingNextPage,
    fetchOlder: () => { void query.fetchNextPage() },
  }
}
