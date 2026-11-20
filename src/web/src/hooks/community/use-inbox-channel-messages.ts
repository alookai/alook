"use client"

import { useCallback, useMemo } from "react"
import { useInfiniteQuery, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query"
import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"
import { useCanonicalChannelsById, useCanonicalMessagesById, useChannelReadStateProjection, useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { communityServerRetirementId, communityServerRetirementKey } from "@/lib/community-db/message-access-scope"
import { communityScopeAllowsAccess } from "@/stores/community/ws-store"
import { useCommunityWsStore } from "@/stores/community/ws"
import { withConversationReadDeadline } from "@/lib/community/conversation-read"
import { messageWindowOptions } from "@/lib/community/message-window"
import { useCommunityMutationOrigin } from "./community-origin"
import { getReadCoordinator } from "./read-coordinator"

export function useInboxChannelMessages(channelId: string, throughSeq: number) {
  const client = useQueryClient()
  const registry = useOptionalCommunityDbRegistry()
  const channel = useCanonicalChannelsById().get(channelId)
  const retiringServers = useMutationState({ filters: { mutationKey: communityServerRetirementKey, status: "pending" }, select: mutation => communityServerRetirementId(mutation, registry) })
  const accessAllowed = useCommunityWsStore(state => state.profileViewerId === registry?.accountId && communityScopeAllowsAccess(state, { channelId, serverId: channel?.serverId ?? undefined }))
    && !(channel?.serverId && retiringServers.includes(channel.serverId))
  const { readState, hasSnapshot } = useChannelReadStateProjection(channelId)
  const afterSeq = readState?.lastReadSeq ?? 0
  const options = messageWindowOptions(client, channelId, { mode: "newest" })
  const query = useInfiniteQuery({
    ...options,
    queryKey: [...options.queryKey, "inbox", afterSeq, throughSeq],
    enabled: hasSnapshot && accessAllowed,
  })
  const references = useMemo(() => query.data?.pages.flatMap(page => page.messages) ?? [], [query.data])
  const ids = useMemo(() => [...new Set(references.map(message => message.id))], [references])
  const canonical = useCanonicalMessagesById(ids)
  const messages = ids.flatMap(id => {
    const message = canonical?.get(id)
    return accessAllowed && message && typeof message.seq === "number" && message.seq > afterSeq && message.seq <= throughSeq
      ? [message] : []
  }).sort((left, right) => left.seq! - right.seq!)
  const oldestSeq = Math.min(...references.flatMap(message => typeof message.seq === "number" ? [message.seq] : []))
  return {
    ...query,
    messages,
    accessAllowed,
    loading: accessAllowed && (!hasSnapshot || query.isPending || ids.some(id => !canonical?.has(id))),
    hasEarlierUnread: query.hasNextPage && oldestSeq > afterSeq + 1,
  }
}

type InboxChannelReadInput = { channelId: string; throughSeq: number }

export function useMarkInboxChannelRead() {
  const client = useQueryClient()
  const origin = useCommunityMutationOrigin()
  type Intent = InboxChannelReadInput & { original: ReturnType<typeof captureCommunityLiveSnapshotToken> }
  const command = useMutation({
    meta: { observabilityAction: "inbox.channel.read" },
    mutationFn: async ({ channelId, throughSeq, original }: Intent) => {
      origin.assert(original)
      if (!Number.isSafeInteger(throughSeq) || throughSeq <= 0) throw new Error("Missing unread boundary")
      const target = await withConversationReadDeadline(undefined, signal => origin.request<{ id: string }>(original,
        `/api/community/channels/${encodeURIComponent(channelId)}/messages/seq/${throughSeq}`, { signal }))
      origin.assert(original)
      if (typeof target.id !== "string" || !target.id) throw new Error("Missing unread message")
      const accountId = original.registry?.accountId
      if (!accountId) throw new DOMException("Missing Inbox account", "AbortError")
      return origin.runWith(original, request =>
        getReadCoordinator(client, accountId).markChannelRead({ channelId, messageId: target.id, seq: throughSeq }, request))
    },
  })
  const capture = useCallback((input: InboxChannelReadInput): Intent => ({
    ...input, original: captureCommunityLiveSnapshotToken(client, input.channelId),
  }), [client])
  const assertCurrent = useCallback((input: Intent) => origin.assert(input.original), [origin])
  return useNativeMutationFacade(command, capture, assertCurrent)
}
