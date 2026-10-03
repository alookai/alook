"use client"

import { useCallback, useEffect, useMemo, type ReactNode } from "react"
import { createStore, createStoreContext, useSelector } from "@tanstack/react-store"
import { hashKey, useQuery } from "@tanstack/react-query"
import { getInboxCount } from "@/lib/api"
import { useAgentContext } from "./agent-context"
import { runWorkspaceRequest, useWorkspaceOwner, type WorkspaceOwner } from "./workspace-context"
import { sendTaskNotification } from "@/lib/browser-notification"
import type { Agent } from "@alook/shared"
function createInboxOwner(workspace: WorkspaceOwner) {
  return {
    workspace,
    ui: createStore({ notificationToken: 0, pendingAgentId: null as string | null, pendingStatus: null as "completed" | "failed" | null, serverBaselines: new Map<string, number>() }),
  }
}
const { StoreProvider, useStoreContext } = createStoreContext<{ owner: ReturnType<typeof createInboxOwner> }>()
export function useInboxCount({ poll = false }: { poll?: boolean } = {}) {
  const { owner } = useStoreContext()
  const { workspace } = owner
  const types = useSelector(workspace.application.preferences, (state) => state.inboxFilterTypes)
  const preferencesHydrated = useSelector(workspace.application.preferences, (state) => state.hydrated)
  const notificationToken = useSelector(owner.ui, (state) => state.notificationToken)
  const key = useMemo(() => workspace.key("inbox-count", types), [workspace, types])
  const query = useQuery({
    queryKey: key, enabled: preferencesHydrated,
    queryFn: ({ signal }) => runWorkspaceRequest(workspace, (options) => getInboxCount(workspace.workspaceId, { types }, options), signal),
    refetchInterval: poll ? 60_000 : false, refetchIntervalInBackground: false,
  })
  const refresh = useCallback(() => {
    void workspace.queryClient.invalidateQueries({ queryKey: workspace.key("inbox-count") })
  }, [workspace])
  const decrement = useCallback(() => {
    if (!workspace.lifecycle.get().active || !workspace.application.lifecycle.get().active) return
    workspace.queryClient.setQueryData<{ count: number }>(key, (data) => ({ count: Math.max(0, (data?.count ?? 0) - 1) }))
  }, [workspace, key])
  return useMemo(() => ({
    queryKey: key, count: query.data?.count ?? 0, notificationToken, resolved: query.isSuccess, dataUpdatedAt: query.dataUpdatedAt,
    refresh, decrement,
  }), [query.data?.count, query.isSuccess, query.dataUpdatedAt, notificationToken, refresh, decrement, key])
}
function InboxCountBootstrap({ owner }: { owner: ReturnType<typeof createInboxOwner> }) {
  const { refresh, queryKey } = useInboxCount({ poll: true })
  const { subscribeWs } = useAgentContext()
  useEffect(() => {
    const hash = hashKey(queryKey)
    return owner.workspace.queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual || event.query.queryHash !== hash) return
      if (!owner.workspace.lifecycle.get().active || !owner.workspace.application.lifecycle.get().active) return
      const next = (event.query.state.data as { count: number }).count
      const previous = owner.ui.get().serverBaselines.get(hash)
      const { pendingAgentId, pendingStatus } = owner.ui.get()
      const notify = previous !== undefined && next > previous
      owner.ui.setState((state) => ({ ...state, notificationToken: state.notificationToken + (notify ? 1 : 0), pendingAgentId: null, pendingStatus: null, serverBaselines: new Map(state.serverBaselines).set(hash, next) }))
      if (notify) {
        void owner.workspace.queryClient.invalidateQueries({ queryKey: owner.workspace.key("inbox") })
        const agents = owner.workspace.queryClient.getQueryData<Agent[]>(owner.workspace.key("agents"))
        sendTaskNotification(pendingStatus ?? "completed", agents?.find((agent) => agent.id === pendingAgentId)?.name, undefined, owner.workspace.application.preferences.get().browserNotifications)
      }
    })
  }, [queryKey, owner])
  useEffect(() => subscribeWs((message) => {
    if (message.type !== "task.updated" || message.status !== "completed" && message.status !== "failed") return
    owner.ui.setState((state) => ({ ...state, pendingAgentId: message.agentId, pendingStatus: message.status as "completed" | "failed" }))
    refresh()
    void owner.workspace.queryClient.invalidateQueries({ queryKey: owner.workspace.key("inbox") })
  }), [owner, refresh, subscribeWs])
  return null
}
export function InboxCountProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspaceOwner()
  const handles = useMemo(() => ({ owner: createInboxOwner(workspace) }), [workspace])
  return <StoreProvider value={handles}><InboxCountBootstrap owner={handles.owner} />{children}</StoreProvider>
}
