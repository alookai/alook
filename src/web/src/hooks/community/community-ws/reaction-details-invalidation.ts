import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { ReactionDetailsEnvelope } from "@/hooks/community/use-reaction-details"

function matchingDetails(
  queryClient: QueryClient,
  predicate: (data: ReactionDetailsEnvelope) => boolean,
): QueryKey[] {
  return queryClient
    .getQueriesData<ReactionDetailsEnvelope>({ queryKey: communityKeys.reactionDetailsAll() })
    .flatMap(([key, data]) => data && predicate(data) ? [key] : [])
}

export function refreshServerReactionDetails(
  queryClient: QueryClient,
  serverId: string,
) {
  for (const key of matchingDetails(
    queryClient,
    (data) => data.scope.kind === "server" && data.scope.serverId === serverId,
  )) {
    void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "active" })
  }
}

export function removeServerReactionDetails(
  queryClient: QueryClient,
  serverId: string,
) {
  for (const key of matchingDetails(
    queryClient,
    (data) => data.scope.kind === "server" && data.scope.serverId === serverId,
  )) {
    queryClient.removeQueries({ queryKey: key, exact: true })
  }
}

export function removeDmReactionDetails(queryClient: QueryClient) {
  for (const key of matchingDetails(queryClient, (data) => data.scope.kind === "dm")) {
    queryClient.removeQueries({ queryKey: key, exact: true })
  }
}
