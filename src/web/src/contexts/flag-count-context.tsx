"use client"

import { useCallback, useMemo, type ReactNode } from "react"
import { createStoreContext } from "@tanstack/react-store"
import { useQuery } from "@tanstack/react-query"
import { beginFlagCountWrite, rollbackFlagCountWrite, type FlagCountData } from "@/lib/workspace-flag-count"
import { getFlaggedCount } from "@/lib/api"
import { runWorkspaceRequest, useWorkspaceOwner, type WorkspaceOwner } from "./workspace-context"
const { StoreProvider, useStoreContext } = createStoreContext<{ workspace: WorkspaceOwner }>()
export function FlagCountProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspaceOwner()
  const handles = useMemo(() => ({ workspace }), [workspace])
  return <StoreProvider value={handles}>{children}</StoreProvider>
}
export function useFlagCount() {
  const { workspace } = useStoreContext()
  const key = useMemo(() => workspace.key("flag-count"), [workspace])
  const query = useQuery({ queryKey: key, queryFn: async ({ signal }) => {
    const requestRevision = workspace.queryClient.getQueryData<FlagCountData>(key)?.revision ?? 0
    const data = await runWorkspaceRequest(workspace, (options) => getFlaggedCount(workspace.workspaceId, options), signal)
    return { ...data, requestRevision } satisfies FlagCountData
  } })
  const refresh = useCallback(() => { void workspace.queryClient.invalidateQueries({ queryKey: key, exact: true }) }, [workspace, key])
  const begin = useCallback((delta: number) => beginFlagCountWrite(workspace, delta), [workspace])
  const rollback = useCallback((ticket: ReturnType<typeof beginFlagCountWrite>) => rollbackFlagCountWrite(workspace, ticket), [workspace])
  return useMemo(() => ({ count: query.data?.count ?? 0, refresh, begin, rollback }), [query.data?.count, refresh, begin, rollback])
}
