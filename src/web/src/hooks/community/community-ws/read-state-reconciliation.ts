import type { queries, CommunityInboxChanged } from "@alook/shared"
import { CancelledError, queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { projectReadCoordinatorSnapshot } from "@/hooks/community/read-coordinator-snapshot-projection"
import { beginCommunityCommandRevision, assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { conversationReadRetryPolicy, isConversationAccessError } from "@/lib/community/conversation-read"
import { isAbortError } from "@/lib/errors"
import { accountAttentionMatchesReadState, reconcileAccountAttention } from "@/hooks/community/use-account-attention"

export type AccountReadStateSnapshot = Awaited<ReturnType<typeof queries.communityReadState.getAccountReadStateSnapshot>>
export type ReadStateEnvelope = Pick<CommunityInboxChanged, "revision" | "inboxChanged">

class ReadStateRevisionPendingError extends Error {}

const disposedClients = new WeakSet<QueryClient>()

function targetRevision(queryClient: QueryClient) {
  const value = queryClient.getQueryCache().find({ queryKey: communityKeys.accountReadStateSnapshot(), exact: true })?.meta?.readStateTargetRevision
  return typeof value === "number" ? value : -1
}

function accountReadStateOptions(queryClient: QueryClient, requestedRevision = -1) {
  const token = getCommunityDbRegistry(queryClient) ? captureCommunityLiveSnapshotToken(queryClient) : null
  const minimumRevision = Math.max(requestedRevision, targetRevision(queryClient))
  return queryOptions({
    queryKey: communityKeys.accountReadStateSnapshot(),
    meta: { readStateTargetRevision: minimumRevision },
    staleTime: 0,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey: communityKeys.accountReadStateSnapshot() }).retry),
    queryFn: async ({ signal }) => {
      if (!token || disposedClients.has(queryClient)) throw new DOMException("Read-state owner retired", "AbortError")
      assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
      const original = queryClient.getQueryCache().find({ queryKey: communityKeys.accountReadStateSnapshot(), exact: true })
      const requestToken = beginCommunityCommandRevision(queryClient, token)
      const snapshot = await apiFetch<AccountReadStateSnapshot>("/api/community/users/me/read-state", communityRequestOptions(queryClient, requestToken, signal))
      assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
      if (!original || queryClient.getQueryCache().get(original.queryHash) !== original) throw new DOMException("Read-state query retired", "AbortError")
      const publication = publishCommunityLiveSnapshot(queryClient, {
        snapshot: { kind: "read-state", data: snapshot },
        proof: { kind: "read-state", token: requestToken, signal, requestGeneration: 0, currentRequestGeneration: 0, targetRevision: Math.max(minimumRevision, targetRevision(queryClient)) },
      })
      if (publication === "superseded") throw new ReadStateRevisionPendingError("Read-state snapshot has not reached the requested revision")
      projectReadCoordinatorSnapshot(queryClient, { readStates: [...token.registry!.collections.readStates.values()] })
      return { revision: token.registry!.collections.readStateClock.get("account")?.revision ?? snapshot.revision }
    },
  })
}

export function useAccountReadState() {
  const queryClient = useQueryClient()
  return useQuery({
    ...accountReadStateOptions(queryClient),
    refetchInterval: (query) => query.state.status === "error" && !isConversationAccessError(query.state.error) && !isAbortError(query.state.error) ? 5_000 : false,
    refetchOnWindowFocus: false,
  })
}

export async function reconcileAccountReadState(
  queryClient: QueryClient,
  options: { targetRevision?: number; reconcileAttention?: boolean } = {},
) {
  if (disposedClients.has(queryClient)) throw new DOMException("Read-state owner retired", "AbortError")
  const token = captureCommunityLiveSnapshotToken(queryClient)
  const query = queryClient.getQueryCache().find({ queryKey: communityKeys.accountReadStateSnapshot(), exact: true })
  if (query && (options.targetRevision ?? -1) > targetRevision(queryClient)) query.setOptions({ ...query.options, meta: { ...query.meta, readStateTargetRevision: options.targetRevision } })
  const read = async () => {
    let result = await queryClient.query({ ...accountReadStateOptions(queryClient, options.targetRevision), retry: (failures, error) => error instanceof ReadStateRevisionPendingError && failures < 3, select: undefined })
    while (result.revision < Math.max(options.targetRevision ?? -1, targetRevision(queryClient))) {
      assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
      result = await queryClient.query({ ...accountReadStateOptions(queryClient, options.targetRevision), retry: (failures, error) => error instanceof ReadStateRevisionPendingError && failures < 3, select: undefined })
    }
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    return { revision: result.revision, readStates: [...token.registry!.collections.readStates.values()] }
  }
  const pending = read()
  if (options.reconcileAttention === false) return pending
  const initialAttention = reconcileAccountAttention(token.registry!)
  const qualifiedRead = pending.then(async snapshot => {
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    if (!accountAttentionMatchesReadState(token.registry!)) await reconcileAccountAttention(token.registry!)
    return snapshot
  })
  const [snapshot, attention] = await Promise.allSettled([qualifiedRead, initialAttention])
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
  if (snapshot.status === "rejected") throw snapshot.reason
  if (attention.status === "rejected" && !(attention.reason instanceof CancelledError)) throw attention.reason
  return snapshot.value
}

export function disposeAccountReadStateReconciliation(queryClient: QueryClient) {
  disposedClients.add(queryClient)
  void queryClient.cancelQueries({ queryKey: communityKeys.accountReadStateSnapshot(), exact: true })
}

export function projectReadStateEnvelope(queryClient: QueryClient, envelope: ReadStateEnvelope) {
  const clock = getCommunityDbRegistry(queryClient)?.collections.readStateClock.get("account")
  const query = queryClient.getQueryCache().find({ queryKey: communityKeys.accountReadStateSnapshot(), exact: true })
  return clock && envelope.revision <= clock.revision && query?.state.status !== "error" ? "stale" as const : "gap" as const
}
