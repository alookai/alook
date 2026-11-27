"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useInfiniteQuery, useIsRestoring, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query"
import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"
import { useCanonicalMessagesById, useChannelReadStateProjection, useOptionalCommunityDbRegistry, useRouteChannelProjection } from "@/lib/community-db/projections"
import { assertCommunitySnapshotTokenCurrent, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { communityServerRetirementId, communityServerRetirementKey } from "@/lib/community-db/message-access-scope"
import { communityScopeAllowsAccess } from "@/stores/community/ws-store"
import { useCommunityWsStore } from "@/stores/community/ws"
import { apiFetch } from "@/lib/api/client"
import { isConversationAccessError, isConversationAnchorMissingError, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { isAbortError } from "@/lib/errors"
import { messageWindowOptions, type MessageWindowData } from "@/lib/community/message-window"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityMutationOrigin } from "./community-origin"
import { getReadCoordinator } from "./read-coordinator"
import type { RequestNativeConversationDismissal } from "./use-native-system-notifications"

const previewRetryDelays = [5_000, 15_000]
const MAX_INBOX_UNREAD_PREVIEW_MESSAGES = 30
const MAX_INBOX_UNREAD_PREVIEW_OLDER_PAGES = 2

export function useInboxChannelMessages(channelId: string, throughSeq: number) {
  const client = useQueryClient()
  const restoring = useIsRestoring()
  const registry = useOptionalCommunityDbRegistry()
  const channel = useRouteChannelProjection(channelId)
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
    retryOnMount: false,
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
  const allUnreadMessages = useMemo(() => ids.flatMap(id => {
    const message = canonical?.get(id)
    return accessAllowed && message && typeof message.seq === "number" && message.seq > afterSeq && message.seq <= throughSeq
      ? [message] : []
  }).sort((left, right) => left.seq! - right.seq!), [accessAllowed, afterSeq, canonical, ids, throughSeq])
  const truncatedByCount = allUnreadMessages.length > MAX_INBOX_UNREAD_PREVIEW_MESSAGES
  const messages = useMemo(
    () => (truncatedByCount ? allUnreadMessages.slice(-MAX_INBOX_UNREAD_PREVIEW_MESSAGES) : allUnreadMessages),
    [allUnreadMessages, truncatedByCount],
  )
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
  const [olderFetchState, setOlderFetchState] = useState<{ client: typeof client; channelId: string; afterSeq: number; throughSeq: number; count: number }>({
    client,
    channelId,
    afterSeq,
    throughSeq,
    count: 0,
  })
  const olderPagesFetched = olderFetchState.client === client
    && olderFetchState.channelId === channelId
    && olderFetchState.afterSeq === afterSeq
    && olderFetchState.throughSeq === throughSeq
    ? olderFetchState.count
    : 0
  const needsNewer = !!first && newestSeq < throughSeq && !checkedTail
  const firstUnreadSeq = afterSeq + 1
  const moreOlderExists = query.hasNextPage && (oldestSeq === undefined || oldestSeq > firstUnreadSeq)
  const previewBounded = allUnreadMessages.length >= MAX_INBOX_UNREAD_PREVIEW_MESSAGES
    || olderPagesFetched >= MAX_INBOX_UNREAD_PREVIEW_OLDER_PAGES
  const needsOlder = moreOlderExists && !previewBounded
  const hasEarlierUnread = truncatedByCount || (moreOlderExists && previewBounded)
  const needsPages = needsNewer || needsOlder
  const windowIncomplete = !first || needsPages
  const { error, errorUpdatedAt, errorUpdateCount, fetchNextPage, fetchPreviousPage, hasPreviousPage, isError, isFetching, isPending, isSuccess, refetch } = query
  const recovery = useRef<{ client: typeof client; channelId: string; attempts: number } | null>(null)
  const loadMissing = useCallback(async (): Promise<{ head: MessageWindowData["pages"][number] | null; fetchedOlder: boolean }> => {
    if (needsNewer) {
      const result = hasPreviousPage
        ? await fetchPreviousPage({ cancelRefetch: false })
        : await refetch({ cancelRefetch: false })
      const head = result.data?.pages[0]
      // A fresh terminal page can cover the tail even when a captured row was deleted.
      if (!result.isError && head && !head.hasMoreNewer && (!hasPreviousPage || head !== first)) {
        return { head, fetchedOlder: false }
      }
      return { head: null, fetchedOlder: false }
    }
    if (needsOlder) {
      const result = await fetchNextPage({ cancelRefetch: false })
      return { head: null, fetchedOlder: !result.isError }
    }
    await refetch({ cancelRefetch: false })
    return { head: null, fetchedOlder: false }
  }, [fetchNextPage, fetchPreviousPage, first, hasPreviousPage, needsNewer, needsOlder, refetch])
  useEffect(() => {
    if (!enabled || isFetching) return
    let active = true
    const runLoadMissing = () => {
      void loadMissing().then(({ head, fetchedOlder }) => {
        if (!active) return
        if (head) setReachedTail({ client, channelId, throughSeq, page: head })
        if (fetchedOlder) {
          setOlderFetchState((prev) => {
            const sameScope = prev.client === client
              && prev.channelId === channelId
              && prev.afterSeq === afterSeq
              && prev.throughSeq === throughSeq
            return {
              client,
              channelId,
              afterSeq,
              throughSeq,
              count: (sameScope ? prev.count : 0) + 1,
            }
          })
        }
      })
    }
    if (isSuccess) {
      recovery.current = null
      if (needsPages) runLoadMissing()
      return () => { active = false }
    }
    if (!isError || !windowIncomplete || isAbortError(error) || isConversationAccessError(error) || isConversationAnchorMissingError(error)) return
    const previous = recovery.current
    const attempts = previous?.client === client && previous.channelId === channelId ? previous.attempts : 0
    const delay = previewRetryDelays[attempts]
    if (delay === undefined) return
    const timer = setTimeout(() => {
      const current = client.getQueryState(communityKeys.channelMessages(channelId))
      if (current?.status !== "error" || current.fetchStatus !== "idle" || current.errorUpdateCount !== errorUpdateCount) return
      recovery.current = { client, channelId, attempts: attempts + 1 }
      runLoadMissing()
    }, Math.max(0, errorUpdatedAt + delay - Date.now()))
    return () => { active = false; clearTimeout(timer) }
  }, [afterSeq, channelId, client, enabled, error, errorUpdatedAt, errorUpdateCount, isError, isFetching, isSuccess, loadMissing, needsPages, throughSeq, windowIncomplete])
  const loading = accessAllowed && (!hasSnapshot || restoring
    || enabled && (isPending || !isError && needsPages || ids.some(id => !canonical?.has(id))))
  return { messages, accessAllowed, loading, hasEarlierUnread, empty: !loading && (!enabled || !windowIncomplete) }
}

type InboxChannelReadInput = { channelId: string; throughSeq: number }
type InboxChannelReadIntent = InboxChannelReadInput & { original: ReturnType<typeof captureCommunityLiveSnapshotToken> }
export type InboxChannelReadAction = { throughSeq: number; status: "pending" | "error" }
const inboxChannelReadKey = ["community", "inbox-channel-read"] as const

export function useMarkInboxChannelRead(dismissConversation?: RequestNativeConversationDismissal) {
  const client = useQueryClient()
  const origin = useCommunityMutationOrigin()
  const command = useMutation({
    mutationKey: inboxChannelReadKey,
    mutationFn: async ({ channelId, throughSeq, original }: InboxChannelReadIntent) => {
      origin.assert(original)
      if (!Number.isSafeInteger(throughSeq) || throughSeq <= 0) throw new Error("Missing unread boundary")
      const registry = original.registry
      const accountId = registry?.accountId
      if (!registry || !accountId) throw new DOMException("Missing Inbox account", "AbortError")
      const receipt = await origin.runWith(original, request => getReadCoordinator(client, accountId).markChannelRead(
        { channelId, seq: throughSeq },
        request,
        async () => {
          const target = await withConversationReadDeadline(request.signal ?? undefined, signal => apiFetch<{ id: string }>(
            `/api/community/channels/${encodeURIComponent(channelId)}/messages/seq/${throughSeq}`, { ...request, signal }))
          if (typeof target.id !== "string" || !target.id) throw new Error("Missing unread message")
          return target.id
        },
      ))
      const channel = registry.collections.channels.get(channelId)
      const remaining = registry.collections.attentionScopes.get(channelId)
      if (channel && Math.max(remaining?.lastUnreadSeq ?? 0, remaining?.lastAttentionSeq ?? 0) <= receipt.targetSeq) {
        if (channel.type === "dm") dismissConversation?.(accountId, { kind: "dm", channelId })
        else if (channel.serverId) dismissConversation?.(accountId, { kind: "server", serverId: channel.serverId, channelId })
      }
      return receipt
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
