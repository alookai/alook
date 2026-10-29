"use client"


import { useEffect, useMemo } from "react"
import {
  useQuery,
  useMutationState,
  useQueryClient,
  queryOptions,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_RESOURCE_CONTRACT_VERSION, CommunityMessageResourcesSchema, CommunityResourceProfileSchema, communityMessageProfileIds, type CommunityMessageRead } from "@alook/shared"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { communityKeys } from "@/lib/query-keys"
import type { MessagesReadPage, Msg } from "@/lib/community/models/message"
import { avatarInitial } from "@/lib/community/avatar"
import { presentCanonicalMessage } from "@/lib/community/message-wire"
import {
  useCanonicalMessagesById,
  useCanonicalProfilesProjection,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import {
  communityServerRetirementId,
  communityServerRetirementKey,
  rememberMessageAccessScope,
  type MessageAccessScope,
} from "@/lib/community-db/message-access-scope"
import { communityScopeAllowsAccess } from "@/stores/community/ws-store"
import { useCommunityWsStore } from "@/stores/community/ws"
import { conversationReadRetryPolicy, withConversationReadDeadline } from "@/lib/community/conversation-read"
import {
  captureCommunityLiveSnapshotToken,
  assertCommunityLiveSnapshotTokenCurrent,
  publishCommunityMessages,
  getCanonicalCommunityMessages, getCanonicalCommunityMessageResources,
} from "@/lib/community-db/sync"

/**
 * Fetches a single hydrated message by id — the payload shape returned by
 * `GET /api/community/messages/:id`. Mirrors the per-message body inside the
 * channel/DM list responses.
 *
 * Used by the thread opener block (parent message pinned atop a thread) and
 * anywhere else that needs a live view of one message. Keyed under
 * `communityKeys.message(id)` so edit/reaction/pin mutations can invalidate
 * (or `setQueryData`-patch) exactly one entry and every viewer of it updates
 * without a page reload.
 *
 * Pass a falsy id when there's nothing to load — the query stays disabled.
 */
export type OpenerPayload = Required<Pick<Msg, "id" | "authorId" | "authorName" | "authorAvatar" | "authorAvatarVersion" | "content" | "type" | "createdAt">>
  & Pick<Msg, "replyTo" | "attachments" | "embeds" | "reactions" | "seq"> & { channelId?: string }

export const messageQueryFn = (
  messageId: string,
  queryClient: QueryClient,
  channelId?: string,
) => (context: QueryFunctionContext) => withConversationReadDeadline(context.signal, async readSignal => {
  if (context.client !== queryClient) throw new DOMException("Mismatched message query owner", "AbortError")
  const token = captureCommunityLiveSnapshotToken(queryClient, channelId)
  const read = await apiFetchCommunity<CommunityMessageRead>(
    `/api/community/messages/${messageId}`,
    { signal: readSignal, headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_RESOURCE_CONTRACT_VERSION) } }, token,
  )
  const message = read.message
  const publishChannelId = message.channelId ?? channelId
  if (publishChannelId) {
    publishCommunityMessages(queryClient, {
      channelId: publishChannelId,
      messages: [message],
      profiles: read.profiles,
      proof: { token, signal: readSignal },
    })
  }
  return message.id
})

function messageQueryOptions(queryClient: QueryClient, messageId: string, channelId?: string) {
  return queryOptions({
    queryKey: communityKeys.message(messageId),
    queryFn: messageQueryFn(messageId, queryClient, channelId),
    staleTime: 30_000,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey: communityKeys.message(messageId) }).retry),
    networkMode: "always",
  })
}

export async function prefetchCommunityMessage(queryClient: QueryClient, messageId: string, scope: MessageAccessScope) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active
    || !communityScopeAllowsAccess(registry.runtime.ws.get(), scope)
    || queryClient.getMutationCache().findAll({ mutationKey: communityServerRetirementKey, status: "pending" }).some(mutation => communityServerRetirementId(mutation, registry) === scope.serverId && scope.serverId != null)) return
  rememberMessageAccessScope(queryClient, messageId, scope)
  if (findCachedMessage(queryClient, messageId)) return
  await queryClient.query({ ...messageQueryOptions(queryClient, messageId, scope.channelId), staleTime: 0, select: undefined })
}

export async function prefetchCommunityLatestMessage(queryClient: QueryClient, channelId: string) {
  const token = captureCommunityLiveSnapshotToken(queryClient, channelId)
  const registry = token.registry
  if (!registry?.runtime.lifecycle.get().active) return
  const scope = { channelId, serverId: registry.collections.channels.get(channelId)?.serverId }
  if (!communityScopeAllowsAccess(registry.runtime.ws.get(), scope)
    || queryClient.getMutationCache().findAll({ mutationKey: communityServerRetirementKey, status: "pending" }).some(mutation => communityServerRetirementId(mutation, registry) === scope.serverId && scope.serverId != null)) return
  const queryKey = communityKeys.channelLatestMessage(channelId)
  await queryClient.cancelQueries({ queryKey, exact: true })
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
  await queryClient.query({
    queryKey,
    staleTime: 0,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey }).retry),
    networkMode: "always",
    queryFn: ({ signal }) => withConversationReadDeadline(signal, async (readSignal) => {
      const page = await apiFetchCommunity<MessagesReadPage>(
        `/api/community/channels/${channelId}/messages?limit=1`,
        { signal: readSignal, headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_RESOURCE_CONTRACT_VERSION) } }, token,
      )
      publishCommunityMessages(queryClient, { channelId, messages: page.messages, profiles: page.profiles, proof: { token, signal: readSignal } })
      return page.messages[0]?.id ?? null
    }),
    select: undefined,
  })
}

export function findCachedMessage(
  queryClient: QueryClient,
  messageId: string,
): OpenerPayload | undefined {
  const message = getCanonicalCommunityMessages(queryClient).find((row) => row.id === messageId)
  if (!message?.authorId || !message.createdAt) return undefined
  const graph = getCanonicalCommunityMessageResources(queryClient, [message])
  const author = graph?.profiles.find(profile => profile.id === message.authorId)
  if (!author) return undefined
  const view = presentCanonicalMessage(message)
  return {
    ...view,
    authorId: message.authorId,
    authorName: author.name,
    authorAvatar: author.avatar ?? avatarInitial(author.name),
    authorAvatarVersion: author.avatarVersion,
    content: message.content,
    createdAt: message.createdAt,
  }

}

export function useMessage(
  messageId: string | null | undefined,
  accessScope?: MessageAccessScope,
): UseQueryResult<string> & { message: OpenerPayload | null } {
  const registry = useOptionalCommunityDbRegistry()
  const selectedIds = useMemo(() => messageId ? [messageId] : [], [messageId])
  const canonicalMessages = useCanonicalMessagesById(selectedIds)
  const queryClient = useQueryClient()
  const retiringServers = useMutationState({ filters: { mutationKey: communityServerRetirementKey, status: "pending" }, select: mutation => communityServerRetirementId(mutation, registry) })
  const accessAllowed = useCommunityWsStore((state) => !accessScope || communityScopeAllowsAccess(state, accessScope))
    && !(accessScope?.serverId && retiringServers.includes(accessScope.serverId))
  const canonical = messageId ? canonicalMessages?.get(messageId) : undefined
  const raw = messageId ? registry?.collections.messages.get(messageId) : undefined
  const profileIds = raw ? communityMessageProfileIds([raw]) : []
  const profiles = useCanonicalProfilesProjection(profileIds)
  const graph = raw ? getCanonicalCommunityMessageResources(queryClient, [raw]) : undefined
  const nativeGraph = graph ? CommunityMessageResourcesSchema.safeParse({ messages: graph.messages, profiles: [...profiles.resourceProfiles.values()].flatMap(profile => {
    const parsed = CommunityResourceProfileSchema.strip().safeParse(profile)
    return parsed.success ? [parsed.data] : []
  }) }) : undefined
  const profilesReady = profileIds.length === 0 || profiles.isReady && !profiles.isError && nativeGraph?.success === true
  const enabled = !!messageId && accessAllowed
  useEffect(() => {
    if (!messageId || !accessScope || !accessAllowed) return
    rememberMessageAccessScope(queryClient, messageId, accessScope)
  }, [accessAllowed, accessScope, messageId, queryClient])
  const placeholderData = messageId && accessAllowed ? findCachedMessage(queryClient, messageId)?.id : undefined

  const query = useQuery({
    ...messageQueryOptions(queryClient, enabled ? messageId! : "__none__", accessScope?.channelId),
    queryFn: enabled
      ? messageQueryFn(messageId!, queryClient, accessScope?.channelId)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
    placeholderData,
  })
  const refetch = query.refetch
  useEffect(() => {
    if (enabled && typeof query.data === "string" && !graph && query.isSuccess && !query.isFetching) void refetch({ cancelRefetch: false })
  }, [enabled, query.data, graph, query.isSuccess, query.isFetching, refetch])
  return {
    ...query,
    message: accessAllowed && profilesReady && canonical && messageId ? findCachedMessage(queryClient, messageId) ?? null : null,
  }
}
