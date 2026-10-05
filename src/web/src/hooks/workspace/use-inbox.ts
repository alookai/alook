"use client"

import { deriveView, valueEvidence } from "@/lib/observability/data-source"

import { useCallback,useMemo } from "react"
import { useSelector } from "@tanstack/react-store"
import { infiniteQueryOptions,useInfiniteQuery,useMutation,type InfiniteData } from "@tanstack/react-query"
import { listInboxItems,listFlaggedItems,markAllInboxRead,unflagMessage } from "@/lib/api"
import { beginFlagCountWrite,rollbackFlagCountWrite } from "@/lib/workspace-flag-count"
import { isAbortError } from "@/lib/errors"
import { assertWorkspaceOwner,captureWorkspaceOwner,runWorkspaceRequest,useWorkspaceOwner,type WorkspaceOwner } from "@/contexts/workspace-context"

type InboxPage = Awaited<ReturnType<typeof listInboxItems>>
type InboxData = InfiniteData<InboxPage, string | undefined>
function firstRows<T extends { id: string }>(pages: readonly { items: T[] }[] | undefined): T[] {
  const seen = new Set<string>()
  return pages?.flatMap((page) => page.items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })) ?? []
}
function workspaceInboxOptions(workspace: WorkspaceOwner, types: readonly string[]) {
  return infiniteQueryOptions({
    queryKey: workspace.key("inbox", types, 30),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => runWorkspaceRequest(workspace, (options) => listInboxItems(workspace.workspaceId, { limit: 30, before: pageParam, types: [...types] }, options), signal),
    getNextPageParam: (page) => page.has_more && page.items.length ? page.items.at(-1)?.latest_response_at : undefined,
  })
}
function workspaceFlagOptions(workspace: WorkspaceOwner) {
  return infiniteQueryOptions({
    queryKey: workspace.key("flagged-items", 30),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => runWorkspaceRequest(workspace, (options) => listFlaggedItems(workspace.workspaceId, { limit: 30, before: pageParam }, options), signal),
    getNextPageParam: (page) => page.has_more && page.items.length ? page.items.at(-1)?.flagged_at : undefined,
  })
}
export function useWorkspaceInbox(enabled = true) {
  const workspace = useWorkspaceOwner()
  const types = useSelector(workspace.application.preferences, (state) => state.inboxFilterTypes)
  const hydrated = useSelector(workspace.application.preferences, (state) => state.hydrated)
  const options = workspaceInboxOptions(workspace, types)
  const query = useInfiniteQuery({ ...options, enabled: enabled && hydrated })
  const items = useMemo(() => firstRows(query.data?.pages), [query.data])
  const refresh = useCallback(() => workspace.queryClient.invalidateQueries({ queryKey: workspace.key("inbox") }), [workspace])
  deriveView(items, [valueEvidence(workspace.queryClient, query.data)])
  return { ...query, items, refresh }
}
export function useMarkAllInboxRead() {
  const workspace = useWorkspaceOwner()
  const qc = workspace.queryClient
  const mutationKey = workspace.key("inbox", "read-all")
  return useMutation({ meta: { observabilityAction: "inbox.read_all" },
    mutationKey,
    scope: { id: JSON.stringify(mutationKey) },
    mutationFn: () => runWorkspaceRequest(workspace, (options) => markAllInboxRead(workspace.workspaceId, options)),
    onMutate: async () => {
      const token = captureWorkspaceOwner(workspace)
      await Promise.all([qc.cancelQueries({ queryKey: workspace.key("inbox") }), qc.cancelQueries({ queryKey: workspace.key("inbox-count") })])
      assertWorkspaceOwner(token)
      const pages = qc.getQueriesData<InboxData>({ queryKey: workspace.key("inbox") }).filter(([, data]) => data?.pages)
      const counts = qc.getQueriesData<{ count: number }>({ queryKey: workspace.key("inbox-count") })
      for (const [key, data] of pages) qc.setQueryData(key, { ...data, pages: data!.pages.map((page) => ({ ...page, items: [], has_more: false })) })
      for (const [key] of counts) qc.setQueryData(key, { count: 0 })
      return { token, snapshots: [...pages, ...counts].map(([key, previous]) => ({ key, previous, optimistic: qc.getQueryData(key) })) }
    },
    onError: (error, _variables, context) => {
      if (!context || isAbortError(error)) return
      try { assertWorkspaceOwner(context.token) } catch { return }
      for (const { key, previous, optimistic } of context.snapshots) if (qc.getQueryData(key) === optimistic) qc.setQueryData(key, previous)
    },
    onSettled: (_data, _error, _variables, context) => {
      if (!context) return
      try { assertWorkspaceOwner(context.token) } catch { return }
      if (qc.isMutating({ mutationKey, exact: true }) !== 1) return
      return Promise.all([qc.invalidateQueries({ queryKey: workspace.key("inbox") }), qc.invalidateQueries({ queryKey: workspace.key("inbox-count") })])
    },
  })
}
export function useWorkspaceFlags(enabled = true) {
  const workspace = useWorkspaceOwner()
  const options = workspaceFlagOptions(workspace)
  const query = useInfiniteQuery({ ...options, enabled })
  const items = useMemo(() => firstRows(query.data?.pages), [query.data])
  deriveView(items, [valueEvidence(workspace.queryClient, query.data)])
  return { ...query, items }
}
export function useUnflagWorkspaceMessage() {
  const workspace = useWorkspaceOwner()
  const qc = workspace.queryClient
  const options = workspaceFlagOptions(workspace)
  const mutationKey = workspace.key("flagged-items", "remove")
  return useMutation({ meta: { observabilityAction: "message.flag.remove" },
    mutationKey, scope: { id: JSON.stringify(mutationKey) },
    mutationFn: (messageId: string) => runWorkspaceRequest(workspace, (request) => unflagMessage(workspace.workspaceId, messageId, request)),
    onMutate: async (messageId) => {
      const token = captureWorkspaceOwner(workspace)
      const countKey = workspace.key("flag-count")
      await Promise.all([qc.cancelQueries({ queryKey: options.queryKey, exact: true }), qc.cancelQueries({ queryKey: countKey, exact: true })])
      assertWorkspaceOwner(token)
      const previous = qc.getQueryData(options.queryKey)
      qc.setQueryData(options.queryKey, (data) => data && ({ ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.message_id !== messageId) })) }))
      const countTicket = beginFlagCountWrite(workspace, -1)
      return { token, previous, optimistic: qc.getQueryData(options.queryKey), countTicket, countKey }
    },
    onError: (error, _messageId, context) => {
      if (!context || isAbortError(error)) return
      try { assertWorkspaceOwner(context.token) } catch { return }
      if (qc.getQueryData(options.queryKey) === context.optimistic) qc.setQueryData(options.queryKey, context.previous)
      rollbackFlagCountWrite(workspace, context.countTicket)
    },
    onSettled: (_data, _error, _messageId, context) => {
      if (!context) return
      try { assertWorkspaceOwner(context.token) } catch { return }
      if (qc.isMutating({ mutationKey, exact: true }) !== 1) return
      return Promise.all([qc.invalidateQueries({ queryKey: options.queryKey, exact: true }), qc.invalidateQueries({ queryKey: context.countKey, exact: true })])
    },
  })
}
