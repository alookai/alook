"use client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { useConversationPresentation } from "@/contexts/view-activity"
import { useMemo } from "react"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"

import { useMutationState, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query"

import { apiFetch } from "@/lib/api/client"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import type { Thread, Msg } from "@/lib/community/models/message"
import {
  materializeCanonicalMessages,
  useCanonicalMessagesById,
  useChildChannelsByParentId,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityResourceBundle,
  publishCommunityForumFeed,
  assertCommunityLiveSnapshotTokenCurrent,
} from "@/lib/community-db/sync"
import type { CommunityFreshQueryProof } from "@/lib/community-db/sync"
import { normalizeThreadResources, projectThread } from "@/lib/community/forum-feed-window"
import { type CommunityThreadsRead, type CommunityChannelResource, type CommunityMessageResource } from "@alook/shared"
import type { ChannelRow } from "@/lib/community-db/schema"
import { forumTagsReadSchema, type ForumTagsSnapshot } from "@/lib/community/page-list-persistence"
import { useCommunityOnlineAccount } from "./community-origin"

export type ThreadsResponse = {
  threads: Array<Pick<CommunityChannelResource, "id"> & { openerMessageId?: CommunityMessageResource["id"] }>
  serverId: NonNullable<CommunityChannelResource["serverId"]>
  parentType: string
  parentChannelId: CommunityChannelResource["id"]
}

async function loadThreadResources(queryClient: QueryClient, channelId: string, proof: CommunityFreshQueryProof) {
  const options = communityRequestOptions(queryClient, proof.token, proof.signal)
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
  await publishCommunityForumFeed(queryClient, channelId, data, { token, signal })
  return { threads: data.threads.map((thread) => ({ id: thread.id, ...(thread.parentMessageId ? { openerMessageId: thread.parentMessageId } : {}) })), parentType: data.channel.type, serverId: data.channel.serverId ?? "", parentChannelId: channelId }
}

export function materializeThreadsResponse(data: ThreadsResponse | undefined, messages: ReadonlyMap<string, Msg> | undefined, channels: ReadonlyMap<string, ChannelRow>): Thread[] {
  if (!data) return []
  return data.threads.flatMap((window) => {
    const thread = channels.get(window.id), opener = window.openerMessageId ? messages?.get(window.openerMessageId) : undefined
    if (!thread || (window.openerMessageId && !opener) || thread.archived) return []
    const core = projectThread(thread, opener, data.parentType, thread.firstMessageId ? messages?.get(thread.firstMessageId) : undefined)
    return [{ ...core, lastMessageAt: thread.lastMessageAt ?? thread.createdAt ?? "", parent: data.parentType === "forum" ? core.parent : { ...core.parent, text: core.parent.text.slice(0, 100) }, ...(window.openerMessageId ? { openerMessageId: window.openerMessageId } : {}) }]
  })
}

export function useThreads(channelId: string | null, requested = true): UseQueryResult<ThreadsResponse> & {
  threads: Thread[]
  canonicalPending: boolean
} {
  const queryClient = useQueryClient()
  const presented = useConversationPresentation()
  const enabled = !!channelId
  const active = enabled && presented && requested
  const channels = useChildChannelsByParentId(channelId, active)
  const query = useQuery({
    queryKey: enabled ? communityKeys.threads(channelId!) : communityKeys.threads("__none__"),
    queryFn: enabled
      ? threadsQueryFn(channelId!, queryClient)
      : (() => Promise.reject(new Error("disabled"))),
    enabled: active,
  })
  const messageIds = useMemo(() => active ? (query.data?.threads.flatMap((thread) => [...(thread.openerMessageId ? [thread.openerMessageId] : []), ...(channels.get(thread.id)?.firstMessageId ? [channels.get(thread.id)!.firstMessageId!] : [])]) ?? []) : [], [active, query.data?.threads, channels])
  const canonicalMessages = useCanonicalMessagesById(messageIds)
  const threads = useMemo(() => active ? materializeThreadsResponse(query.data, canonicalMessages, channels) : [], [active, query.data, canonicalMessages, channels])
  return {
    ...query,
    threads,
    canonicalPending: active && !!query.data?.threads.length && !query.isError
      && (query.data.threads.some(row => !channels.has(row.id)) || messageIds.some(id => !canonicalMessages?.has(id))),
  }
}

export const forumTagsQueryFn = (channelId: string, queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}): Promise<ForumTagsSnapshot> => {
    const token = captureCommunityLiveSnapshotToken(queryClient, channelId)
    const data = forumTagsReadSchema.parse(await apiFetchCommunity<unknown>(
      `/api/community/channels/${channelId}/messages/tags`, signal ? { signal } : undefined, token,
    ))
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
    return { ...data, observed: true }
  }

export function useForumTags(channelId: string | null, enabled: boolean) {
  const presented = useConversationPresentation()
  const online = useCommunityOnlineAccount()
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: communityKeys.forumTags(channelId ?? "__none__"),
    queryFn: channelId ? forumTagsQueryFn(channelId, queryClient) : () => Promise.reject(new Error("disabled")),
    enabled: !!channelId && enabled && presented && online,
  })
}

export type PinsResponse = { pins: Array<Pick<CommunityMessageResource, "id">>; resources: import("@alook/shared").CommunityResourceBundle }
export type PinsWindowResponse = { pins: Array<Pick<CommunityMessageResource, "id">> }

export const pinsQueryFn = (channelId: string, queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}) => {
    const publicationToken = captureCommunityLiveSnapshotToken(queryClient, channelId)
    const data = await apiFetchCommunity<PinsResponse>(
      `/api/community/channels/${channelId}/pins`,
      signal ? { signal } : undefined, publicationToken,
    )
    await publishCommunityResourceBundle(queryClient, data.resources, { token: publicationToken, signal }, data.pins.map(row => ({ id: row.id, channelId })))
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
    canonicalPending: enabled && ids.length > 0 && !!query.data && !query.isError && ids.some(id => !canonicalMessages?.has(id)),
  }
}
