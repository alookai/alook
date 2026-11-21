"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useInfiniteQuery, useIsRestoring, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query"
import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"
import { useCanonicalChannelsById, useCanonicalMessagesById, useChannelReadStateProjection, useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { assertCommunitySnapshotTokenCurrent, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { communityServerRetirementId, communityServerRetirementKey } from "@/lib/community-db/message-access-scope"
import { communityScopeAllowsAccess } from "@/stores/community/ws-store"
import { useCommunityWsStore } from "@/stores/community/ws"
import { apiFetch } from "@/lib/api/client"
import { withConversationReadDeadline } from "@/lib/community/conversation-read"
import { isAbortError } from "@/lib/errors"
import { messageWindowOptions, type MessageWindowData } from "@/lib/community/message-window"
import { useCommunityMutationOrigin } from "./community-origin"
import { getReadCoordinator } from "./read-coordinator"

export function useInboxChannelMessages(channelId: string, throughSeq: number) {
  const client = useQueryClient()
  const restoring = useIsRestoring()
  const registry = useOptionalCommunityDbRegistry()
  const channel = useCanonicalChannelsById().get(channelId)
  const retiringServers = useMutationState({ filters: { mutationKey: communityServerRetirementKey, status: "pending" }, select: mutation => communityServerRetirementId(mutation, registry) })
  const accessAllowed = useCommunityWsStore(state => state.profileViewerId === registry?.accountId && communityScopeAllowsAccess(state, { channelId, serverId: channel?.serverId ?? undefined }))
    && !(channel?.serverId && retiringServers.includes(channel.serverId))
  const { readState, hasSnapshot } = useChannelReadStateProjection(channelId)
  const afterSeq = readState?.lastReadSeq ?? 0
  const enabled = hasSnapshot && accessAllowed && !restoring && afterSeq < throughSeq
  const options = messageWindowOptions(client, channelId, { mode: "newest" })
  const query = useInfiniteQuery({
    ...options,
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    getPreviousPageParam: (...args) => {
      const [page, pages] = args
      const previous = options.getPreviousPageParam?.(...args)
      if (previous) return previous
      const tail = pages.find(part => part.newestCursor)
      const cursor = tail?.newestCursor
      if (!cursor || (page.latestSeq ?? 0) >= throughSeq || page.messages.some(message => (message.seq ?? 0) >= throughSeq)) return
      return { mode: "newer" as const, cursor }
    },
  })
  const references = useMemo(() => query.data?.pages.flatMap(page => page.messages) ?? [], [query.data])
  const ids = useMemo(() => [...new Set(references.map(message => message.id))], [references])
  const canonical = useCanonicalMessagesById(ids)
  const messages = useMemo(() => ids.flatMap(id => {
    const message = canonical?.get(id)
    return accessAllowed && message && typeof message.seq === "number" && message.seq > afterSeq && message.seq <= throughSeq
      ? [message] : []
  }).sort((left, right) => left.seq! - right.seq!), [accessAllowed, afterSeq, canonical, ids, throughSeq])
  const first = query.data?.pages[0]
  const oldest = query.data?.pages.at(-1)?.messages[0]
  const oldestSeq = oldest && (oldest.seq ?? canonical?.get(oldest.id)?.seq)
  const newerId = first?.hasMoreNewer ? first.newerCursor?.split("|").at(-1) : undefined
  const newestSeq = newerId
    ? first?.messages.find(message => message.id === newerId)?.seq ?? canonical?.get(newerId)?.seq ?? 0
    : first?.messages.reduce((latest, message) => Math.max(latest, message.seq ?? canonical?.get(message.id)?.seq ?? 0),
      first.hasMoreNewer ? 0 : first.latestSeq ?? 0) ?? 0
  const [reachedTail, setReachedTail] = useState<{ client: typeof client; channelId: string; throughSeq: number; page: MessageWindowData["pages"][number] } | null>(null)
  const checkedTail = reachedTail?.client === client && reachedTail.channelId === channelId
    && reachedTail.throughSeq === throughSeq && reachedTail.page === first
  const needsNewer = !!first && newestSeq < throughSeq && !checkedTail
  const firstUnreadSeq = afterSeq + 1
  const needsOlder = query.hasNextPage && (oldestSeq === undefined || oldestSeq > firstUnreadSeq)
  const { fetchNextPage, fetchPreviousPage, hasPreviousPage, isError, isFetching, isPending, refetch } = query
  const loadMissing = useCallback(async () => {
    if (needsNewer) {
      const result = hasPreviousPage
        ? await fetchPreviousPage({ cancelRefetch: false })
        : await refetch({ cancelRefetch: false })
      const head = result.data?.pages[0]
      // A fresh terminal page can cover the tail even when a captured row was deleted.
      if (!result.isError && head && !head.hasMoreNewer && (!hasPreviousPage || head !== first)) {
        setReachedTail({ client, channelId, throughSeq, page: head })
      }
      return
    }
    if (needsOlder) await fetchNextPage({ cancelRefetch: false })
    else await refetch({ cancelRefetch: false })
  }, [channelId, client, fetchNextPage, fetchPreviousPage, first, hasPreviousPage, needsNewer, needsOlder, refetch, throughSeq])
  useEffect(() => {
    if (enabled && !isFetching && !isError && (needsNewer || needsOlder)) void loadMissing()
  }, [enabled, isError, isFetching, loadMissing, needsNewer, needsOlder])
  return {
    messages,
    accessAllowed,
    isError: enabled && isError && (isPending || !first || needsNewer || needsOlder),
    isFetching,
    loading: accessAllowed && (!hasSnapshot || restoring || enabled && (isPending || needsNewer || needsOlder || ids.some(id => !canonical?.has(id)))),
    refetch: loadMissing,
  }
}

type InboxChannelReadInput = { channelId: string; throughSeq: number }
type InboxChannelReadIntent = InboxChannelReadInput & { original: ReturnType<typeof captureCommunityLiveSnapshotToken> }
export type InboxChannelReadAction = { throughSeq: number; status: "pending" | "error" }
const inboxChannelReadKey = ["community", "inbox-channel-read"] as const

export function useMarkInboxChannelRead() {
  const client = useQueryClient()
  const origin = useCommunityMutationOrigin()
  const command = useMutation({
    mutationKey: inboxChannelReadKey,
    meta: { observabilityAction: "inbox.channel.read" },
    mutationFn: async ({ channelId, throughSeq, original }: InboxChannelReadIntent) => {
      origin.assert(original)
      if (!Number.isSafeInteger(throughSeq) || throughSeq <= 0) throw new Error("Missing unread boundary")
      const accountId = original.registry?.accountId
      if (!accountId) throw new DOMException("Missing Inbox account", "AbortError")
      return origin.runWith(original, request => getReadCoordinator(client, accountId).markChannelRead(
        { channelId, seq: throughSeq },
        request,
        async () => {
          const target = await withConversationReadDeadline(request.signal ?? undefined, signal => apiFetch<{ id: string }>(
            `/api/community/channels/${encodeURIComponent(channelId)}/messages/seq/${throughSeq}`, { ...request, signal }))
          if (typeof target.id !== "string" || !target.id) throw new Error("Missing unread message")
          return target.id
        },
      ))
    },
  })
  const capture = useCallback((input: InboxChannelReadInput): InboxChannelReadIntent => ({
    ...input, original: captureCommunityLiveSnapshotToken(client, input.channelId),
  }), [client])
  const assertCurrent = useCallback((input: InboxChannelReadIntent) => origin.assert(input.original), [origin])
  const mutations = useMutationState({
    filters: { mutationKey: inboxChannelReadKey, exact: true },
    select: ({ state }) => ({
      intent: state.variables as InboxChannelReadIntent | undefined,
      status: state.status,
      aborted: isAbortError(state.error),
    }),
  })
  const actions = new Map<string, InboxChannelReadAction>()
  for (const { intent, status, aborted } of mutations) {
    if (!intent) continue
    try {
      assertCommunitySnapshotTokenCurrent(client, intent.original, undefined)
    } catch {
      continue
    }
    const { channelId, throughSeq } = intent
    const confirmedSeq = intent.original.registry?.collections.readStates.get(channelId)?.lastReadSeq ?? 0
    if (status === "pending" || status === "error" && !aborted && confirmedSeq < throughSeq) actions.set(channelId, { throughSeq, status })
    else actions.delete(channelId)
  }
  return { ...useNativeMutationFacade(command, capture, assertCurrent), actions }
}
