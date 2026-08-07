"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { Thread, Msg } from "@/components/community/_types"

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
const EMPTY_THREADS: readonly Thread[] = Object.freeze([])
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
type ParticipantRow = { channelId: string; userId: string; userName: string | null; userImage: string | null; addedAt: string; participantCount?: number }

async function loadThreadResources(channelId: string, tag?: string | null) {
  const query = tag ? `?tag=${encodeURIComponent(tag)}` : ""
  const { threads } = await apiFetch<{ threads: RawThread[] }>(`/api/community/channels/${channelId}/threads${query}`)
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
      body: JSON.stringify({ parentChannelId: channelId, channelIds: threadIds }),
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

export function useForumTags(channelId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: communityKeys.forumTags(channelId ?? "__none__"),
    queryFn: () => apiFetch<{ tags: string[] }>(`/api/community/channels/${channelId}/messages/tags`),
    enabled: !!channelId && enabled,
  })
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
