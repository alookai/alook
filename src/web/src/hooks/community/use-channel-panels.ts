"use client"
import { useMemo } from "react"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"


import { useMutationState, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query"
import { communityRequestOptions } from "@/lib/community-db/sync"
import { apiFetch } from "@/lib/api/client"
import { apiFetchCommunity, communityRequestOptions as qualifiedCommunityRequestOptions } from "@/lib/community/account-cache-lifecycle"
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
import type { CommunityFreshQueryProof } from "@/lib/community-db/sync"
import { normalizeThreadResources, projectThread, type ForumFeedTransportPage } from "./forum-feed-window"
import type { CommunityThreadsRead } from "@alook/shared"
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

async function loadThreadResources(queryClient: QueryClient, channelId: string, proof: CommunityFreshQueryProof) {
  const options = qualifiedCommunityRequestOptions(queryClient, proof.token, proof.signal)
  const response = await apiFetch<ForumFeedTransportPage | CommunityThreadsRead>(`/api/community/channels/${channelId}/threads?include=parentMessage,firstMessage,tags,participants`, options)
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  if ("contractVersion" in response || response.included) return normalizeThreadResources(channelId, response)
  const openerIds = response.threads.flatMap((thread) => thread.parentMessageId ? [thread.parentMessageId] : [])
  const threadIds = response.threads.map((thread) => thread.id)
  const [messages, tags, participants] = await Promise.all([
    apiFetch<Pick<ForumFeedTransportPage["included"], "parentMessages" | "firstMessages"> & { messages: ForumFeedTransportPage["included"]["parentMessages"] }>("/api/community/messages/batch", { method: "POST", body: JSON.stringify({ channelId, ids: openerIds, firstInChannelIds: threadIds }), ...options }),
    apiFetch<Pick<ForumFeedTransportPage["included"], "tags">>("/api/community/messages/tags/batch", { method: "POST", body: JSON.stringify({ channelId, messageIds: openerIds }), ...options }),
    apiFetch<Pick<ForumFeedTransportPage["included"], "participants">>("/api/community/channels/participants/batch", { method: "POST", body: JSON.stringify({ parentChannelId: channelId, channelIds: threadIds }), ...options }),
  ])
  return normalizeThreadResources(channelId, { ...response, hasMore: false, included: { parentMessages: messages.messages.map((message) => ({ ...message, authorAvatarVersion: message.authorAvatarVersion ?? 0 })), firstMessages: messages.firstMessages, tags: tags.tags, participants: participants.participants.map((participant) => ({ ...participant, userAvatarVersion: participant.userAvatarVersion ?? 0 })) } })
}

export const threadsQueryFn = (channelId: string, queryClient: QueryClient) => async ({ signal }: { signal?: AbortSignal } = {}) => {
  const token = captureCommunityLiveSnapshotToken(queryClient, channelId), registry = getCommunityDbRegistry(queryClient)
  await registry?.ready
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
  await Promise.all([registry!.collections.channels.preload(), registry!.collections.messages.preload(), registry!.collections.channelMemberships.preload()])
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
  const data = await loadThreadResources(queryClient, channelId, { token, signal })
  publishCommunityForumFeed(queryClient, channelId, data, { token, signal })
  return { threads: data.threads.map((thread) => ({ id: thread.id, ...(thread.parentMessageId ? { openerMessageId: thread.parentMessageId } : {}) })), parentType: data.channel.type, serverId: data.channel.serverId ?? "", parentChannelId: channelId }
}

export function materializeThreadsResponse(data: ThreadsResponse | undefined, messages: ReadonlyMap<string, Msg> | undefined, channels: ReadonlyMap<string, ChannelRow>): Thread[] {
  if (!data) return []
  return data.threads.flatMap((window) => {
    const thread = channels.get(window.id), opener = window.openerMessageId ? messages?.get(window.openerMessageId) : undefined
    if (!thread || (window.openerMessageId && !opener) || thread.archived) return []
    const core = projectThread(thread, opener, data.parentType)
    return [{ ...core, lastMessageAt: thread.lastMessageAt ?? thread.createdAt ?? "", parent: { ...core.parent, text: core.parent.text.slice(0, 100) }, ...(window.openerMessageId ? { openerMessageId: window.openerMessageId } : {}) }]
  })
}

export function useThreads(channelId: string | null): UseQueryResult<ThreadsResponse> & {
  threads: Thread[]
} {
  const queryClient = useQueryClient()
  const channels = useCanonicalChannelsById()
  const enabled = !!channelId
  const query = useQuery({
    queryKey: enabled ? communityKeys.threads(channelId!) : communityKeys.threads("__none__"),
    queryFn: enabled
      ? threadsQueryFn(channelId!, queryClient)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  const messageIds = useMemo(() => query.data?.threads.flatMap((thread) => thread.openerMessageId ? [thread.openerMessageId] : []) ?? [], [query.data?.threads])
  const canonicalMessages = useCanonicalMessagesById(messageIds)
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
export type PinsResponse = { pins: Array<Pick<Msg, "id" | "seq" | "authorId" | "authorName" | "authorAvatar" | "authorAvatarVersion" | "content" | "createdAt">> }
export type PinsWindowResponse = { pins: Array<{ id: string }> }

export const pinsQueryFn = (channelId: string, queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}) => {
    const publicationToken = captureCommunityLiveSnapshotToken(queryClient, channelId)
    const data = await apiFetchCommunity<PinsResponse>(
      `/api/community/channels/${channelId}/pins`,
      signal ? { signal } : undefined, publicationToken,
    )
    {
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
  const enabled = !!channelId
  const query = useQuery({
    queryKey: enabled ? communityKeys.pins(channelId!) : communityKeys.pins("__none__"),
    queryFn: enabled
      ? pinsQueryFn(channelId!, queryClient)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
  })
  const pending = useMutationState({ filters: { mutationKey: ["community", "pin-command"], status: "pending" }, select: (mutation) => ({ channelId: (mutation.state.variables as { channelId: string }).channelId, messageId: (mutation.state.variables as { messageId: string }).messageId, pinned: mutation.options.mutationKey?.[2] === "pin" }) })
  const ids = useMemo(() => {
    const ids = new Set(query.data?.pins.map((row) => row.id) ?? [])
    for (const command of pending) if (command.channelId === channelId) { if (command.pinned) ids.add(command.messageId); else ids.delete(command.messageId) }
    return [...ids]
  }, [query.data?.pins, pending, channelId])
  const canonicalMessages = useCanonicalMessagesById(ids)
  return {
    ...query,
    pins: materializeCanonicalMessages(ids.map((id) => ({ id })), canonicalMessages),
  }
}
