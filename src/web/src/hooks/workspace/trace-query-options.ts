import { infiniteQueryOptions } from "@tanstack/react-query"
import { listTraces } from "@/lib/api"
import { runWorkspaceRequest, type WorkspaceOwner } from "@/contexts/workspace-context"

export function workspaceTracesOptions(owner: WorkspaceOwner, filters: { status: string; agentId: string; channel: string }) {
  return infiniteQueryOptions({
    queryKey: owner.key("traces", "list", filters),
    initialPageParam: null as string | null,
    staleTime: 0,
    queryFn: ({ signal, pageParam }) => runWorkspaceRequest(owner, (options) => listTraces(owner.workspaceId, {
      limit: 30,
      before: pageParam ?? undefined,
      status: filters.status === "all" ? undefined : filters.status || undefined,
      multiAgent: true,
      agentId: filters.agentId || undefined,
      channel: filters.channel || undefined,
    }, options), signal),
    getNextPageParam: (page) => page.has_more && page.traces.length ? page.traces.at(-1)!.started_at : undefined,
  })
}
