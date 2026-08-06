"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { Thread, ForumThread, Msg } from "@/components/community/_types"
import { avatarInitial } from "@/lib/community/avatar"

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
const EMPTY_THREADS: readonly Thread[] = Object.freeze([])
const EMPTY_FORUM_THREADS: readonly ForumThread[] = Object.freeze([])
const EMPTY_PINS: readonly Msg[] = Object.freeze([])

/**
 * Fetches the thread list rendered in a channel's right rail (`?panel=threads`).
 *
 * The server already resolves parent-message / creator / first-message
 * previews server-side so the payload is render-ready. Query key is nested
 * under `communityKeys.channelMessages`'s sibling grain so an invite from
 * WS (`community:channel.child_create`) can invalidate the thread list only
 * — without touching messages.
 */
export type ThreadsResponse = { threads: Thread[] }

type RawThread = {
  id: string
  name: string
  type: string
  creatorId: string | null
  parentMessageId: string | null
  messageCount: number | null
  lastMessageAt: string | null
  createdAt: string
}
type BatchMessage = {
  id: string
  channelId: string
  content: string
  seq: number
  authorId: string
  authorName: string
  authorImage: string | null
}
type ParticipantRow = { channelId: string; userId: string; userName: string | null; userImage: string | null; addedAt: string }

async function loadThreadResources(channelId: string) {
  const { threads } = await apiFetch<{ threads: RawThread[] }>(`/api/community/channels/${channelId}/threads`)
  const openerIds = threads.map((thread) => thread.parentMessageId).filter((id): id is string => !!id)
  const threadIds = threads.map((thread) => thread.id)
  const [messageBatch, tagBatch, participantBatch] = await Promise.all([
    apiFetch<{ messages: BatchMessage[]; firstMessages: BatchMessage[] }>("/api/community/messages/batch", {
      method: "POST",
      body: JSON.stringify({ channelId, ids: openerIds, firstInChannelIds: threadIds }),
    }),
    apiFetch<{ tags: { messageId: string; tag: string }[] }>("/api/community/messages/tags/batch", {
      method: "POST",
      body: JSON.stringify({ channelId, messageIds: openerIds }),
    }),
    apiFetch<{ participants: ParticipantRow[] }>("/api/community/channels/participants/batch", {
      method: "POST",
      body: JSON.stringify({ channelIds: threadIds }),
    }),
  ])
  return { threads, openerIds, ...messageBatch, ...tagBatch, ...participantBatch }
}

export const threadsQueryFn = (channelId: string) => async () => {
  const data = await loadThreadResources(channelId)
  const openerMap = new Map(data.messages.map((message) => [message.id, message]))
  const firstMap = new Map(data.firstMessages.map((message) => [message.channelId, message]))
  return {
    threads: data.threads.map((thread): Thread => {
      const opener = thread.parentMessageId ? openerMap.get(thread.parentMessageId) : undefined
      const first = firstMap.get(thread.id)
      return {
        id: thread.id,
        name: thread.name,
        messageCount: thread.messageCount ?? 0,
        lastMessageAt: thread.lastMessageAt ?? thread.createdAt,
        parent: { authorName: opener?.authorName ?? "", text: (opener?.content ?? first?.content ?? "").slice(0, 100) },
        ...(opener ? { parentSeq: opener.seq } : {}),
      }
    }),
  }
}

export function useThreads(channelId: string | null): UseQueryResult<ThreadsResponse> & {
  threads: Thread[]
} {
  const enabled = !!channelId
  const query = useQuery({
    queryKey: enabled ? communityKeys.threads(channelId!) : communityKeys.threads("__none__"),
    queryFn: enabled ? threadsQueryFn(channelId!) : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    threads: query.data?.threads ?? (EMPTY_THREADS as Thread[]),
  }
}

/**
 * Fetches the forum-post listing for a `type='forum'` channel. Server-side
 * resolves creator + first-message + counts; the payload is display-ready.
 */
export type ForumThreadsResponse = { threads: ForumThread[] }

export const forumThreadsQueryFn = (channelId: string) => async (): Promise<ForumThreadsResponse> => {
  const data = await loadThreadResources(channelId)
  const openerMap = new Map(data.messages.map((message) => [message.id, message]))
  const firstMap = new Map(data.firstMessages.map((message) => [message.channelId, message]))
  const tagsByMessage = new Map<string, string[]>()
  for (const row of data.tags) tagsByMessage.set(row.messageId, [...(tagsByMessage.get(row.messageId) ?? []), row.tag])
  const participantsByChannel = new Map<string, ForumThread["participants"]>()
  for (const row of [...data.participants].sort((a, b) => a.addedAt.localeCompare(b.addedAt))) {
    participantsByChannel.set(row.channelId, [
      ...(participantsByChannel.get(row.channelId) ?? []),
      { id: row.userId, name: row.userName ?? "", avatar: row.userImage ?? avatarInitial(row.userName ?? "") },
    ])
  }
  return {
    threads: data.threads.map((thread): ForumThread => {
      const opener = thread.parentMessageId ? openerMap.get(thread.parentMessageId) : undefined
      const first = firstMap.get(thread.id)
      const authorId = thread.creatorId ?? opener?.authorId ?? ""
      const authorName = opener?.authorName ?? ""
      return {
        id: thread.id,
        name: opener?.content ?? thread.name,
        messageCount: thread.messageCount ?? 0,
        lastMessageAt: thread.lastMessageAt ?? thread.createdAt,
        parent: { authorName, text: (first?.content ?? "").slice(0, 100) },
        authorId,
        authorAvatar: opener?.authorImage ?? avatarInitial(authorName),
        openerMessageId: opener?.id ?? thread.parentMessageId ?? "",
        tags: thread.parentMessageId ? tagsByMessage.get(thread.parentMessageId) ?? [] : [],
        preview: (first?.content ?? "").slice(0, 100),
        participants: participantsByChannel.get(thread.id) ?? [],
      }
    }),
  }
}

/**
 * Fetches forum posts. Only enabled when the channel is a `forum` — otherwise
 * the server returns 400 "channel is not a forum" and TanStack Query would
 * retry it. Callers must pass the channel's type gate; passing `false` (or a
 * null channelId) leaves the query disabled and no request fires.
 */
export function useForumThreads(
  channelId: string | null,
  isForum: boolean = true,
): UseQueryResult<ForumThreadsResponse> & { threads: ForumThread[] } {
  const enabled = !!channelId && isForum
  const query = useQuery({
    queryKey: enabled ? communityKeys.forumThreads(channelId!) : communityKeys.forumThreads("__none__"),
    queryFn: enabled
      ? forumThreadsQueryFn(channelId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    threads: query.data?.threads ?? (EMPTY_FORUM_THREADS as ForumThread[]),
  }
}

/**
 * Fetches the pinned-message list for a channel. Server-side hydrates the
 * author + content so no follow-up fetch is needed.
 */
export type PinsResponse = { pins: Msg[] }

export const pinsQueryFn = (channelId: string) => () =>
  apiFetch<PinsResponse>(`/api/community/channels/${channelId}/pins`)

export function usePins(channelId: string | null): UseQueryResult<PinsResponse> & {
  pins: Msg[]
} {
  const enabled = !!channelId
  const query = useQuery({
    queryKey: enabled ? communityKeys.pins(channelId!) : communityKeys.pins("__none__"),
    queryFn: enabled ? pinsQueryFn(channelId!) : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  return {
    ...query,
    pins: query.data?.pins ?? (EMPTY_PINS as Msg[]),
  }
}
