"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query"
import { DEFAULT_MESSAGE_PAGE_SIZE } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { avatarInitial } from "@/lib/community/avatar"
import { readForumTagSelection, validateForumTagSelection, writeForumTagSelection } from "@/lib/community/forum-tag-selection"
import type { ForumThread } from "@/components/community/_types"
import { useForumTags } from "./use-channel-panels"

type ActivityThread = {
  id: string
  name: string | null
  creatorId: string | null
  messageCount: number | null
  parentMessageId: string | null
  lastMessageAt: string | null
  createdAt: string
  activityAt: string
}

type IncludedMessage = {
  id: string
  channelId: string
  content: string
  authorId: string
  authorName: string
  authorImage: string | null
}

type IncludedFirstMessage = { channelId: string; content: string }
type IncludedTag = { messageId: string; tag: string }
type IncludedParticipant = {
  channelId: string
  userId: string
  userName: string | null
  userImage: string | null
  participantCount?: number
}

export type ForumActivityPage = {
  threads: ActivityThread[]
  included: {
    parentMessages: IncludedMessage[]
    firstMessages: IncludedFirstMessage[]
    tags: IncludedTag[]
    participants: IncludedParticipant[]
  }
  hasMore: boolean
  nextCursor?: string
}

export function forumActivityPageQueryFn(channelId: string, tag: string | null) {
  return ({ pageParam }: { pageParam: string | null }) => {
    const params = new URLSearchParams({
      order: "activity",
      limit: String(DEFAULT_MESSAGE_PAGE_SIZE),
      include: "parentMessage,firstMessage,tags,participants",
    })
    if (tag) params.set("tag", tag)
    if (pageParam) params.set("cursor", pageParam)
    return apiFetch<ForumActivityPage>(
      `/api/community/channels/${channelId}/threads?${params.toString()}`,
    )
  }
}

export function mapForumActivityPages(pages: ForumActivityPage[]): ForumThread[] {
  const byId = new Map<string, ForumThread>()
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
          avatar: row.userImage ?? avatarInitial(row.userName ?? ""),
        },
      ])
      participantCountByChannel.set(row.channelId, Number(row.participantCount ?? 0))
    }

    for (const thread of page.threads) {
      if (byId.has(thread.id)) continue
      const opener = thread.parentMessageId ? openerById.get(thread.parentMessageId) : undefined
      const first = firstByChannel.get(thread.id)
      byId.set(thread.id, {
        id: thread.id,
        name: opener?.content.trim() || thread.name?.trim() || "Post",
        messageCount: thread.messageCount ?? 0,
        lastMessageAt: thread.activityAt,
        parent: {
          authorName: opener?.authorName ?? "",
          text: (first?.content ?? "").slice(0, 100),
        },
        authorId: opener?.authorId ?? thread.creatorId ?? "",
        authorAvatar: opener?.authorImage ?? avatarInitial(opener?.authorName ?? ""),
        openerMessageId: thread.parentMessageId ?? "",
        tags: thread.parentMessageId ? tagsByMessage.get(thread.parentMessageId) ?? [] : [],
        preview: (first?.content ?? "").slice(0, 100),
        participants: participantsByChannel.get(thread.id) ?? [],
        participantCount: participantCountByChannel.get(thread.id) ?? 0,
      })
    }
  }
  return [...byId.values()].sort((a, b) => {
    const activity = b.lastMessageAt.localeCompare(a.lastMessageAt)
    return activity || b.id.localeCompare(a.id)
  })
}

export function useForumFeed(_serverId: string, channelId: string) {
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
  const queryKey = communityKeys.forumActivityFeed(channelId, selectedTag)
  const query = useInfiniteQuery<
    ForumActivityPage,
    Error,
    InfiniteData<ForumActivityPage, string | null>,
    typeof queryKey,
    string | null
  >({
    queryKey,
    queryFn: forumActivityPageQueryFn(channelId, selectedTag),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
  })
  const posts = useMemo(
    () => mapForumActivityPages(query.data?.pages ?? []),
    [query.data?.pages],
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
