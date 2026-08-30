import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { ReactionDetailsEnvelope } from "@/hooks/community/use-reaction-details"

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
  for (const [key, data] of reactionDetails(queryClient)) {
    if (data && (data.scope.kind !== "server" || data.scope.serverId !== serverId)) continue
    queryClient.removeQueries({ queryKey: key, exact: true })
  }
}

export function removeDmReactionDetails(queryClient: QueryClient) {
  for (const [key, data] of reactionDetails(queryClient)) {
    if (data && data.scope.kind !== "dm") continue
    queryClient.removeQueries({ queryKey: key, exact: true })
  }
}
