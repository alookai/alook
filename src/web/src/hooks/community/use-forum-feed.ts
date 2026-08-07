"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { avatarInitial } from "@/lib/community/avatar"
import { readForumTagSelection, validateForumTagSelection, writeForumTagSelection } from "@/lib/community/forum-tag-selection"
import { useForumTags } from "./use-channel-panels"
import { useMessages } from "./use-messages"

export function useForumFeed(serverId: string, channelId: string) {
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
  const feed = useMessages(channelId, {
    serverId,
    lastReadMessageId: null,
    anchorMessageId: null,
    tag: tag === "All" ? null : tag,
  })
  const posts = useMemo(() => feed.messages.flatMap((message) => {
    const thread = message.thread
    if (!thread) return []
    return [{
      id: thread.id,
      name: message.content ?? thread.name,
      messageCount: thread.messageCount,
      lastMessageAt: thread.lastReplyAt ?? message.createdAt ?? "",
      parent: { authorName: message.authorName ?? "", text: thread.preview ?? "" },
      authorId: message.authorId ?? "",
      authorAvatar: message.authorAvatar ?? avatarInitial(message.authorName ?? ""),
      openerMessageId: message.id,
      tags: thread.tags ?? [],
      preview: thread.preview ?? "",
      participants: thread.participants ?? [],
      participantCount: thread.participantCount ?? 0,
    }]
  }), [feed.messages])

  return { ...feed, posts, tag, selectTag, availableTags: tagsQuery.data?.tags ?? [] }
}
