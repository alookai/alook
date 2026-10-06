"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useWorkspaceViewSource } from "./use-workspace-view-source"

import { useMutation, useMutationState, type Query } from "@tanstack/react-query"
import type { CreateIssueRequest, Issue, UpdateIssueRequest } from "@alook/shared"
import { createIssue, updateIssue, deleteIssue, createIssueComment, type IssueListItem } from "@/lib/api"
import { captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, type WorkspaceOwner } from "@/contexts/workspace-context"
import type { WorkspaceIssueDetail } from "@/lib/workspace-issue-reconciliation"

type IssueAction = { kind: "create"; values: CreateIssueRequest & { files?: File[] } } | { kind: "update"; id: string; patch: UpdateIssueRequest } | { kind: "delete"; id: string } | { kind: "comment"; id: string; content: string }
type IssueIntent = { action: IssueAction; token: ReturnType<typeof captureWorkspaceOwner>; assertActive?: (() => void) & { signal: AbortSignal } }

function mergeConfirmed(current: IssueListItem, before: IssueListItem | undefined, confirmed: Issue): IssueListItem {
  const next = { ...current }
  for (const [field, value] of Object.entries(confirmed)) {
    if (field === "updated_at") {
      next.updated_at = current.updated_at > confirmed.updated_at ? current.updated_at : confirmed.updated_at
    } else if ((current as unknown as Record<string, unknown>)[field] === (before as unknown as Record<string, unknown> | undefined)?.[field]) {
      (next as unknown as Record<string, unknown>)[field] = value
    }
  }
  return next
}

export function useIssueCommand(owner: WorkspaceOwner) {
  const key = owner.key("issue-command")
  const source = useWorkspaceViewSource(owner, "issue-command", true)
  type NativeIntent = IssueIntent & { view: ReturnType<typeof source.capture>; resources: Query[] }
  const native = useMutation({ meta: { observabilityAction: "issue.command" }, mutationKey: key, scope: { id: JSON.stringify(key) }, gcTime: 0,
    mutationFn: async ({ action, token, view, resources, assertActive }: NativeIntent) => {
      const qc = owner.queryClient, assert = () => { assertWorkspaceOwner(token, assertActive?.signal ?? view.signal); view.assert(); assertActive?.() }
      assert()
      await Promise.all(resources.filter((query) => qc.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query).map((query) => qc.cancelQueries({ queryKey: query.queryKey, exact: true })))
      assert()
      const lists = resources.filter((query) => owner.key("issues", "list").every((value, index) => Object.is(value, query.queryKey[index]))).map((query) => ({ query, before: query.state.data as IssueListItem[] | undefined, writes: query.state.dataUpdateCount }))
      const id = action.kind === "create" ? null : action.id
      const detailKey = owner.key("issues", "detail", id ?? "__none__")
      const detailQuery = resources.find((query) => JSON.stringify(query.queryKey) === JSON.stringify(detailKey))
      const beforeDetail = detailQuery?.state.data as WorkspaceIssueDetail | undefined
      const detailWrites = detailQuery?.state.dataUpdateCount
      const original = (query: (typeof lists)[number]["query"]) => qc.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query
      try {
        const options = workspaceRequestOptions(token, assertActive?.signal ?? view.signal, assert)
        if (action.kind === "comment") {
          const { comment } = await createIssueComment(owner.workspaceId, action.id, action.content, options)
          assert()
          if (detailQuery && original(detailQuery)) qc.setQueryData<WorkspaceIssueDetail>(detailKey, (detail) => {
            if (!detail || detail.comments.some((row) => row.id === comment.id)) return detail
            const revision = (detail.liveRevision ?? 0) + 1
            return { ...detail, comments: [...detail.comments, comment], liveRevision: revision, liveFields: { ...detail.liveFields, comments: revision } }
          })
          await Promise.all(resources.filter(original).map((query) => qc.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false })))
          assert()
          return null
        }
        const confirmed = action.kind === "create" ? (await createIssue(owner.workspaceId, action.values, options)).issue
          : action.kind === "update" ? await updateIssue(owner.workspaceId, action.id, action.patch, options)
          : (await deleteIssue(owner.workspaceId, action.id, options), null)
        assert()
        for (const { query, before, writes } of lists) {
          if (!original(query) || query.state.dataUpdateCount !== writes || !Array.isArray(query.state.data)) continue
          qc.setQueryData<IssueListItem[]>(query.queryKey, (rows) => {
            if (!rows) return rows
            if (action.kind === "delete") return rows.filter((row) => row.id !== action.id)
            if (action.kind === "create") return rows.some((row) => row.id === confirmed!.id) ? rows : [confirmed!, ...rows]
            return rows.map((row) => row.id === action.id ? mergeConfirmed(row, before?.find((candidate) => candidate.id === row.id), confirmed!) : row)
          })
        }
        if (detailQuery && original(detailQuery) && detailQuery.state.dataUpdateCount === detailWrites) {
          if (action.kind === "delete") qc.removeQueries({ queryKey: detailKey, exact: true })
          else if (action.kind === "update") qc.setQueryData<WorkspaceIssueDetail>(detailKey, (detail) => {
            if (!detail) return detail
            const revision = (detail.liveRevision ?? 0) + 1
            return { ...detail, issue: mergeConfirmed(detail.issue, beforeDetail?.issue, confirmed!), liveRevision: revision, liveFields: { ...detail.liveFields, issue: revision } }
          })
        }
        await Promise.all(resources.filter(original).map((query) => qc.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false })))
        assert()
        return confirmed
      } catch (error) { assert(); throw error }
    },
  })
  const capture = useCallback((input: IssueIntent): NativeIntent => {
    const view = source.capture()
    view.assert(); assertWorkspaceOwner(input.token); input.assertActive?.()
    return { ...input, view, resources: [...new Set([owner.key("issues")].flatMap((queryKey) => owner.queryClient.getQueryCache().findAll({ queryKey })))] }
  }, [owner, source])
  const assertCurrent = useCallback((args: NativeIntent) => { args.view.assert(); assertWorkspaceOwner(args.token); args.assertActive?.() }, [])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

export function usePendingIssueChanges(owner: WorkspaceOwner) {
  return useMutationState({ filters: { mutationKey: owner.key("issue-command"), status: "pending" }, select: (mutation) => (mutation.state.variables as IssueIntent).action })
}
