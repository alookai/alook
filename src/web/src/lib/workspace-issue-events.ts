import type { WsMessage, Issue } from "@alook/shared"
import type { IssueListItem } from "@/lib/api"
import { captureWorkspaceOwner, assertWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context"
import type { WorkspaceIssueDetail } from "./workspace-issue-reconciliation"

export function publishWorkspaceIssueEvent(owner: WorkspaceOwner, message: WsMessage) {
  const qc = owner.queryClient
  const token = captureWorkspaceOwner(owner)
  assertWorkspaceOwner(token)
  const invalidate = (key: readonly unknown[]) => {
    void qc.cancelQueries({ queryKey: key }).then(() => { assertWorkspaceOwner(token); return qc.invalidateQueries({ queryKey: key }) }).catch(() => undefined)
  }
  if (message.type === "task.updated") {
    invalidate(owner.key("chat", "task", message.taskId))
    for (const query of qc.getQueryCache().findAll({ queryKey: owner.key("issues", "detail") })) {
      const detail = query.state.data as WorkspaceIssueDetail | undefined
      if (detail && (detail.issue.latest_task_id === message.taskId || detail.issue.agent_id === message.agentId)) invalidate(query.queryKey)
    }
    for (const query of qc.getQueryCache().findAll({ queryKey: owner.key("issues", "list") })) {
      const rows = query.state.data as IssueListItem[] | undefined
      if (Array.isArray(rows) && (rows.length === 0 || rows.some((row) => row.latest_task_id === message.taskId || row.agent_id === message.agentId))) invalidate(query.queryKey)
    }
    return
  }
  if (message.type !== "conversation.message" && message.type !== "issue.comment") return
  const eventStatus = message.type === "conversation.message" && message.message.role === "event" && message.message.content.startsWith("Issue status changed:") ? message.message.content.match(/-> (\w+)/)?.[1] as Issue["status"] | undefined : undefined
  for (const query of qc.getQueryCache().findAll({ queryKey: owner.key("issues", "detail") })) {
    const previous = query.state.data as WorkspaceIssueDetail | undefined
    if (!previous) continue
    let next = previous
    const fields: NonNullable<WorkspaceIssueDetail["liveFields"]> = {}
    const revision = (previous.liveRevision ?? 0) + 1
    if (message.type === "conversation.message" && previous.issue.conversation_id === message.conversationId) {
      if (!previous.messages.some((row) => row.id === message.message.id)) { next = { ...next, messages: [...next.messages, message.message] }; fields.messages = revision }
      if (eventStatus && message.message.created_at >= previous.issue.updated_at && eventStatus !== previous.issue.status) { next = { ...next, issue: { ...next.issue, status: eventStatus, updated_at: message.message.created_at } }; fields.issue = revision }
    }
    if (message.type === "issue.comment" && previous.issue.id === message.issueId && !previous.comments.some((row) => row.id === message.comment.id)) { next = { ...next, comments: [...next.comments, message.comment] }; fields.comments = revision }
    if (next !== previous) qc.setQueryData(query.queryKey, { ...next, liveRevision: revision, liveFields: { ...previous.liveFields, ...fields } })
  }
  if (message.type === "conversation.message" && eventStatus) {
    for (const query of qc.getQueryCache().findAll({ queryKey: owner.key("issues", "list") })) {
      if (!Array.isArray(query.state.data)) continue
      qc.setQueryData<IssueListItem[]>(query.queryKey, (rows) => rows?.map((row) => row.conversation_id === message.conversationId && message.message.created_at >= row.updated_at ? { ...row, status: eventStatus, updated_at: message.message.created_at } : row))
    }
    invalidate(owner.key("issues", "list"))
  }
}
