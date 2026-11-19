import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { ReactionDetailsEnvelope } from "@/hooks/community/use-reaction-details"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"

function retireReactionScope(queryClient: QueryClient, scope: { kind: "reaction-server" | "reaction-dm"; id: string }) {
  void getCommunityDbRegistry(queryClient)?.retireAuxiliaryDisk([scope]).catch(cause => console.error("Reaction cache retirement failed", cause))
}

function removeReactionQuery(queryClient: QueryClient, key: QueryKey) {
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  void query?.cancel({ revert: false })
  query?.setState({ data: undefined, dataUpdatedAt: 0 })
  queryClient.removeQueries({ queryKey: key, exact: true })
}

function reactionDetails(
  queryClient: QueryClient,
): Array<[QueryKey, ReactionDetailsEnvelope | undefined]> {
  return queryClient
    .getQueriesData<ReactionDetailsEnvelope>({ queryKey: communityKeys.reactionDetailsAll() })
}

export function refreshServerReactionDetails(
  queryClient: QueryClient,
  serverId: string,
) {
  retireReactionScope(queryClient, { kind: "reaction-server", id: serverId })
  for (const [key, data] of reactionDetails(queryClient)) {
    if (!data) {
      void queryClient.resetQueries({ queryKey: key, exact: true })
      continue
    }
    if (data.scope.kind !== "server" || data.scope.serverId !== serverId) continue
    void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "active" })
  }
}

export function removeServerReactionDetails(
  queryClient: QueryClient,
  serverId: string,
) {
  retireReactionScope(queryClient, { kind: "reaction-server", id: serverId })
  for (const [key, data] of reactionDetails(queryClient)) {
    if (data && (data.scope.kind !== "server" || data.scope.serverId !== serverId)) continue
    removeReactionQuery(queryClient, key)
  }
}

export function removeDmReactionDetails(queryClient: QueryClient) {
  retireReactionScope(queryClient, { kind: "reaction-dm", id: "all" })
  for (const [key, data] of reactionDetails(queryClient)) {
    if (data && data.scope.kind !== "dm") continue
    removeReactionQuery(queryClient, key)
  }
}
