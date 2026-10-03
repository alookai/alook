"use client"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"


import { useMutationState, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query"
import { communityRequestOptions } from "@/lib/community-db/sync"
import { apiFetch } from "@/lib/api/client"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { Thread, Msg } from "@/lib/community/models/message"
import {
  materializeCanonicalMessages,
  useCanonicalMessagesById,
  useCanonicalChannelsById,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityEmbeddedMessages,
  publishCommunityForumFeed,
  assertCommunityLiveSnapshotTokenCurrent,
} from "@/lib/community-db/sync"
import { communityRequestOptions as qualifiedCommunityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import type { CommunityFreshQueryProof } from "@/lib/community-db/sync"
import type { ChannelRow } from "@/lib/community-db/schema"

/**
 * Fetches the thread list rendered in a channel's right rail (`?panel=threads`).
 *
 * The server already resolves parent-message / creator / first-message
 * previews server-side so the payload is render-ready. Query key is nested
 * under `communityKeys.channelMessages`'s sibling grain so an invite from
 * WS (`community:channel.child_create`) can invalidate the thread list only
 * — without touching messages.
 */
export type ThreadsResponse = {
  threads: Array<{ id: string; openerMessageId?: string }>
  serverId: string
  parentType: string
  parentChannelId: string
}

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
type FirstMessagePreview = { channelId: string; content: string }
type ParticipantRow = { channelId: string; userId: string; userName: string | null; userImage: string | null; addedAt: string; participantCount?: number }

async function loadThreadResources(queryClient: QueryClient, channelId: string, proof: CommunityFreshQueryProof, tag?: string | null) {
  const options = qualifiedCommunityRequestOptions(queryClient, proof.token, proof.signal)
  const query = tag ? `?tag=${encodeURIComponent(tag)}` : ""
  const { threads, parentType, serverId } = await apiFetch<{
    threads: RawThread[]
    parentType: string
    serverId: string
  }>(
    `/api/community/channels/${channelId}/threads${query}`,
    options,
  )
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const openerIds = threads.map((thread) => thread.parentMessageId).filter((id): id is string => !!id)
  const threadIds = threads.map((thread) => thread.id)
  const [messageBatch, tagBatch, participantBatch] = await Promise.all([
    apiFetch<{ messages: BatchMessage[]; firstMessages: FirstMessagePreview[] }>("/api/community/messages/batch", {
      method: "POST",
      body: JSON.stringify({ channelId, ids: openerIds, firstInChannelIds: threadIds }),
      ...options,
    }),
    apiFetch<{ tags: { messageId: string; tag: string }[] }>("/api/community/messages/tags/batch", {
      method: "POST",
      body: JSON.stringify({ channelId, messageIds: openerIds }),
      ...options,
    }),
    apiFetch<{ participants: ParticipantRow[] }>("/api/community/channels/participants/batch", {
      method: "POST",
      body: JSON.stringify({ parentChannelId: channelId, channelIds: threadIds }),
      ...options,
    }),
  ])
  return { threads, parentType, serverId, openerIds, ...messageBatch, ...tagBatch, ...participantBatch }
}

export const threadsQueryFn = (channelId: string, queryClient: QueryClient) => async ({ signal }: { signal?: AbortSignal } = {}) => {
  const token = captureCommunityLiveSnapshotToken(queryClient), registry = getCommunityDbRegistry(queryClient)
  await registry?.ready
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
  await Promise.all([registry!.collections.channels.preload(), registry!.collections.messages.preload(), registry!.collections.channelMemberships.preload()])
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
  const data = await loadThreadResources(queryClient, channelId, { token, signal })
  publishCommunityForumFeed(queryClient, channelId, {
    serverId: data.serverId, parentType: data.parentType, hasMore: false,
    threads: data.threads.map((thread) => ({ ...thread, activityAt: thread.lastMessageAt ?? thread.createdAt })),
    included: {
      parentMessages: data.messages.map((message) => ({ ...message, authorAvatarVersion: 0 })),
      firstMessages: data.firstMessages, tags: data.tags,
      participants: data.participants.map((participant) => ({ ...participant, userAvatarVersion: 0 })),
    },
  }, { token, signal })
  return { threads: data.threads.map((thread) => ({ id: thread.id, ...(thread.parentMessageId ? { openerMessageId: thread.parentMessageId } : {}) })), parentType: data.parentType, serverId: data.serverId, parentChannelId: channelId }
}

export function materializeThreadsResponse(data: ThreadsResponse | undefined, messages: ReadonlyMap<string, Msg> | undefined, channels: ReadonlyMap<string, ChannelRow>): Thread[] {
  if (!data) return []
  return data.threads.flatMap((window) => {
    const thread = channels.get(window.id), opener = window.openerMessageId ? messages?.get(window.openerMessageId) : undefined
    if (!thread || (window.openerMessageId && !opener) || thread.archived) return []
    return [{ id: thread.id, name: data.parentType === "forum" ? (opener?.content?.trim() ? opener.content : thread.name || "Post") : thread.name, messageCount: thread.messageCount ?? 0, lastMessageAt: thread.lastMessageAt ?? thread.createdAt ?? "", parent: { authorId: opener?.authorId, authorName: opener?.authorName ?? "", text: (data.parentType === "forum" ? thread.preview ?? "" : opener?.content ?? thread.preview ?? "").slice(0, 100) }, ...(opener?.seq === undefined ? {} : { parentSeq: opener.seq }), ...(window.openerMessageId ? { openerMessageId: window.openerMessageId } : {}) }]
  })
}

export function useThreads(channelId: string | null): UseQueryResult<ThreadsResponse> & {
  threads: Thread[]
} {
  const queryClient = useQueryClient()
  const canonicalMessages = useCanonicalMessagesById()
  const channels = useCanonicalChannelsById()
  const enabled = !!channelId
  const query = useQuery({
    queryKey: enabled ? communityKeys.threads(channelId!) : communityKeys.threads("__none__"),
    queryFn: enabled
      ? threadsQueryFn(channelId!, queryClient)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  const threads = materializeThreadsResponse(query.data, canonicalMessages, channels)
  return {
    ...query,
    threads,
  }
}

export function useForumTags(channelId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: communityKeys.forumTags(channelId ?? "__none__"),
    queryFn: ({ client, signal }) => apiFetch<{ tags: string[] }>(`/api/community/channels/${channelId}/messages/tags`, communityRequestOptions(client, signal)),
    enabled: !!channelId && enabled,
  })
}

/**
 * Fetches the pinned-message list for a channel. Server-side hydrates the
 * author + content so no follow-up fetch is needed.
 */
export type PinsResponse = { pins: Msg[] }
export type PinsWindowResponse = { pins: Array<{ id: string }> }

export const pinsQueryFn = (channelId: string, queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}) => {
    const publicationToken = queryClient
      ? captureCommunityLiveSnapshotToken(queryClient)
      : null
    const data = await apiFetchProfiles<PinsResponse>(
      `/api/community/channels/${channelId}/pins`,
      (response) => messageProfilePatches(response.pins),
      signal ? { signal } : undefined, getCommunityDbRegistry(queryClient),
    )
    if (queryClient && publicationToken) {
      publishCommunityEmbeddedMessages(queryClient, {
        entries: data.pins.map((message) => ({ channelId, message })),
        proof: { token: publicationToken, signal },
      })
    }
    return { pins: data.pins.map((message) => ({ id: message.id })) }
  }

export function usePins(channelId: string | null): UseQueryResult<PinsWindowResponse> & {
  pins: Msg[]
} {
  const queryClient = useQueryClient()
  const canonicalMessages = useCanonicalMessagesById()
  const enabled = !!channelId
  const query = useQuery({
    queryKey: enabled ? communityKeys.pins(channelId!) : communityKeys.pins("__none__"),
    queryFn: enabled
      ? pinsQueryFn(channelId!, queryClient)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  const pending = useMutationState({ filters: { mutationKey: ["community", "pin-command"], status: "pending" }, select: (mutation) => ({ channelId: (mutation.state.variables as { channelId: string }).channelId, messageId: (mutation.state.variables as { messageId: string }).messageId, pinned: mutation.options.mutationKey?.[2] === "pin" }) })
  const ids = new Set(query.data?.pins.map((row) => row.id) ?? [])
  for (const command of pending) if (command.channelId === channelId) { if (command.pinned) ids.add(command.messageId); else ids.delete(command.messageId) }
  return {
    ...query,
    pins: materializeCanonicalMessages([...ids].map((id) => ({ id })), canonicalMessages),
  }
}
