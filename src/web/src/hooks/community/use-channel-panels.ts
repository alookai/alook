"use client"
import { useConversationPresentation } from "@/contexts/community/conversation-activity"
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
  publishCommunityResourceBundle,
  publishCommunityForumFeed,
  assertCommunityLiveSnapshotTokenCurrent,
} from "@/lib/community-db/sync"
import type { CommunityFreshQueryProof } from "@/lib/community-db/sync"
import { normalizeThreadResources, projectThread } from "./forum-feed-window"
import { type CommunityThreadsRead, type CommunityChannelResource, type CommunityMessageResource } from "@alook/shared"
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
  threads: Array<Pick<CommunityChannelResource, "id"> & { openerMessageId?: CommunityMessageResource["id"] }>
  serverId: NonNullable<CommunityChannelResource["serverId"]>
  parentType: string
  parentChannelId: CommunityChannelResource["id"]
}

async function loadThreadResources(queryClient: QueryClient, channelId: string, proof: CommunityFreshQueryProof) {
  const options = qualifiedCommunityRequestOptions(queryClient, proof.token, proof.signal)
  const response = await apiFetch<CommunityThreadsRead>(`/api/community/channels/${channelId}/threads?include=parentMessage,firstMessage,tags,participants&archived=false`, options)
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  return normalizeThreadResources(channelId, response)
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
    return [{ ...core, lastMessageAt: thread.lastMessageAt ?? thread.createdAt ?? "", parent: data.parentType === "forum" ? core.parent : { ...core.parent, text: core.parent.text.slice(0, 100) }, ...(window.openerMessageId ? { openerMessageId: window.openerMessageId } : {}) }]
  })
}

export function useThreads(channelId: string | null, requested = true): UseQueryResult<ThreadsResponse> & {
  threads: Thread[]
} {
  const queryClient = useQueryClient()
  const channels = useCanonicalChannelsById()
  const presented = useConversationPresentation()
  const enabled = !!channelId
  const query = useQuery({
    queryKey: enabled ? communityKeys.threads(channelId!) : communityKeys.threads("__none__"),
    queryFn: enabled
      ? threadsQueryFn(channelId!, queryClient)
      : (() => Promise.reject(new Error("disabled"))),
    enabled: enabled && presented && requested,
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
  const presented = useConversationPresentation()
  return useQuery({
    queryKey: communityKeys.forumTags(channelId ?? "__none__"),
    queryFn: ({ client, signal }) => apiFetch<{ tags: string[] }>(`/api/community/channels/${channelId}/messages/tags`, communityRequestOptions(client, signal)),
    enabled: !!channelId && enabled && presented,
  })
}

/**
 * Fetches the pinned-message list for a channel. Server-side hydrates the
 * author + content so no follow-up fetch is needed.
 */
export type PinsResponse = { pins: Array<Pick<CommunityMessageResource, "id">>; resources: import("@alook/shared").CommunityResourceBundle }
export type PinsWindowResponse = { pins: Array<Pick<CommunityMessageResource, "id">> }

export const pinsQueryFn = (channelId: string, queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}) => {
    const publicationToken = captureCommunityLiveSnapshotToken(queryClient, channelId)
    const data = await apiFetchCommunity<PinsResponse>(
      `/api/community/channels/${channelId}/pins`,
      signal ? { signal } : undefined, publicationToken,
    )
    publishCommunityResourceBundle(queryClient, data.resources, { token: publicationToken, signal }, data.pins.map(row => ({ id: row.id, channelId })))
    return { pins: data.pins.map((message) => ({ id: message.id })) }
  }

export function usePins(channelId: string | null): UseQueryResult<PinsWindowResponse> & {
  pins: Msg[]
  canonicalPending: boolean
} {
  const queryClient = useQueryClient()
  const presented = useConversationPresentation()
  const enabled = !!channelId
  const query = useQuery({
    queryKey: enabled ? communityKeys.pins(channelId!) : communityKeys.pins("__none__"),
    queryFn: enabled
      ? pinsQueryFn(channelId!, queryClient)
      : (() => Promise.reject(new Error("disabled"))),
    enabled: enabled && presented,
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
    canonicalPending: enabled && !!query.data && !query.isError && canonicalMessages === undefined,
  }
}
