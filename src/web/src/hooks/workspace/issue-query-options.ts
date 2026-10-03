import { captureQueryReceipt, withQueryReceipt, reconcileQueryReceipt } from "@/lib/query-receipt"
import { queryOptions } from "@tanstack/react-query"
import { getIssue, getTrace, getTask, listIssues } from "@/lib/api"
import { captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, runWorkspaceRequest, type WorkspaceOwner } from "@/contexts/workspace-context"
import type { WorkspaceIssueDetail } from "@/lib/workspace-issue-reconciliation"

export function workspaceIssueOptions(owner: WorkspaceOwner, issueId: string) {
  const key = owner.key("issues", "detail", issueId)
  return queryOptions({ queryKey: key, staleTime: 0,
    queryFn: async ({ signal }): Promise<WorkspaceIssueDetail> => {
      const token = captureWorkspaceOwner(owner)
      const assertActive = () => assertWorkspaceOwner(token, signal)
      assertActive()
      const requestRevision = owner.queryClient.getQueryData<WorkspaceIssueDetail>(key)?.liveRevision ?? 0
      const data = await getIssue(owner.workspaceId, issueId, workspaceRequestOptions(token, signal, assertActive))
      assertActive()
      return { ...data, requestRevision }
    },
  })
}
export function workspaceTraceOptions(owner: WorkspaceOwner, traceId: string) {
  return queryOptions({ queryKey: owner.key("traces", "detail", traceId), staleTime: 0,
    queryFn: async ({ signal }) => { const token = captureWorkspaceOwner(owner); const assertActive = () => assertWorkspaceOwner(token, signal); assertActive(); const data = await getTrace(traceId, owner.workspaceId, workspaceRequestOptions(token, signal, assertActive)); assertActive(); return data },
  })
}
export function workspaceTaskOptions(owner: WorkspaceOwner, taskId: string) {
  return queryOptions({ queryKey: owner.key("chat", "task", taskId), staleTime: 0, structuralSharing: reconcileQueryReceipt,
    queryFn: async ({ signal }) => { const token = captureWorkspaceOwner(owner); const assertActive = () => assertWorkspaceOwner(token, signal); assertActive(); const receipt = captureQueryReceipt(owner.queryClient, owner.key("chat", "task", taskId)); const data = await getTask(taskId, owner.workspaceId, workspaceRequestOptions(token, signal, assertActive)); assertActive(); return withQueryReceipt(data, receipt) },
  })
}

export function workspaceIssueListOptions(owner: WorkspaceOwner) {
  return queryOptions({ queryKey: owner.key("issues", "list", "board"), structuralSharing: (oldData, newData) => {
    if (!Array.isArray(oldData) || !Array.isArray(newData)) return newData
    const before = new Map((oldData as Awaited<ReturnType<typeof listIssues>>).map((row) => [row.id, row]))
    return (newData as Awaited<ReturnType<typeof listIssues>>).map((row) => {
      const previous = before.get(row.id)
      return previous && previous.updated_at > row.updated_at ? previous : row
    })
  }, queryFn: ({ signal }) => runWorkspaceRequest(owner, async (options) => {
    const [active, completed] = await Promise.all([listIssues(owner.workspaceId, { terminal: false }, options), listIssues(owner.workspaceId, { terminal: true }, options)])
    return [...active, ...completed]
  }, signal) })
}
