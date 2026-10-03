import { replaceEqualDeep } from "@tanstack/react-query"
import type { IssueDetailResponse } from "@/lib/api"

export type WorkspaceIssueDetail = IssueDetailResponse & { liveRevision?: number; liveFields?: Partial<Record<"issue" | "messages" | "comments" | "artifacts", number>>; requestRevision?: number }
export function reconcileWorkspaceIssue(previous: unknown, incoming: unknown): unknown {
  const next = incoming as WorkspaceIssueDetail | undefined
  const old = previous as WorkspaceIssueDetail | undefined
  if (next?.requestRevision === undefined) return replaceEqualDeep(previous, incoming)
  const { requestRevision, ...data } = next
  if (!old) return replaceEqualDeep(previous, data)
  const live = (field: keyof NonNullable<WorkspaceIssueDetail["liveFields"]>) => (old.liveFields?.[field] ?? 0) > requestRevision
  const merge = <T extends { id: string }>(before: T[], after: T[]) => [...new Map([...after, ...before].map((row) => [row.id, row])).values()]
  return replaceEqualDeep(previous, {
    ...data, liveRevision: old.liveRevision, liveFields: old.liveFields,
    issue: live("issue") ? old.issue : data.issue,
    messages: live("messages") ? merge(old.messages, data.messages).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)) : data.messages,
    comments: live("comments") ? merge(old.comments, data.comments) : data.comments,
    artifacts: live("artifacts") ? merge(old.artifacts, data.artifacts) : data.artifacts,
  })
}
