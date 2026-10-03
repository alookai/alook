"use client"

import { useCallback,useEffect,useMemo } from "react"
import { createStore,useSelector } from "@tanstack/react-store"
import { useQuery,isCancelledError } from "@tanstack/react-query"
import { toast } from "sonner"
import type { UpdateIssueRequest } from "@alook/shared"
import { useIssueCommand,usePendingIssueChanges } from "./workspace/use-issue-command"
import { captureWorkspaceOwner } from "@/contexts/workspace-context"
import { isAbortError } from "@/lib/errors"
import type { WorkspaceOwner } from "@/contexts/workspace-context"
import { workspaceIssueOptions,workspaceTraceOptions,workspaceTaskOptions } from "./workspace/issue-query-options"
import { useChatArtifactSelection } from "./workspace/use-chat-artifact-selection"
import { captureChatIntent,assertChatIntent } from "./workspace/use-chat-data"
type ChatView = Parameters<typeof captureChatIntent>[1]
export function useChatSheets(owner: WorkspaceOwner, view: ChatView) {
  const store = useMemo(() => createStore({ artifactSheetOpen: false, emailSheetOpen: false, selectedEmailId: null as string | null, calendarEventSheetOpen: false, selectedCalendarEventId: null as string | null, issueSheetOpen: false, selectedIssueId: null as string | null, issueGeneration: 0 }), [])
  const ui = useSelector(store, (state) => state)
  const generation = useSelector(view, (state) => state.generation)
  const capture = useCallback(() => {
    const intent = captureChatIntent(owner, view)
    const state = store.get()
    return () => {
      assertChatIntent(intent)
      const current = store.get()
      if (current.issueGeneration !== state.issueGeneration || current.selectedIssueId !== state.selectedIssueId || !current.issueSheetOpen) throw new DOMException("Retired issue selection", "AbortError")
    }
  }, [owner, view, store])
  const setArtifactSheetOpen = useCallback((value: boolean) => store.setState((state) => ({ ...state, artifactSheetOpen: value })), [store])
  const setEmailSheetOpen = useCallback((value: boolean) => store.setState((state) => ({ ...state, emailSheetOpen: value })), [store])
  const setSelectedEmailId = useCallback((value: string | null) => store.setState((state) => ({ ...state, selectedEmailId: value })), [store])
  const setCalendarEventSheetOpen = useCallback((value: boolean) => store.setState((state) => ({ ...state, calendarEventSheetOpen: value })), [store])
  const setSelectedCalendarEventId = useCallback((value: string | null) => store.setState((state) => ({ ...state, selectedCalendarEventId: value })), [store])
  const setIssueSheetOpen = useCallback((value: boolean) => store.setState((state) => ({ ...state, issueSheetOpen: value, issueGeneration: value === state.issueSheetOpen ? state.issueGeneration : state.issueGeneration + 1 })), [store])
  const setSelectedIssueId = useCallback((value: string | null) => store.setState((state) => ({ ...state, selectedIssueId: value, issueGeneration: state.issueGeneration + 1 })), [store])
  const [selectedArtifact, setSelectedArtifact] = useChatArtifactSelection(owner, view, ui.selectedIssueId)
  const readSource = useMemo(() => {
    const intent = { workspace: captureWorkspaceOwner(owner), view, generation }
    const selected = { generation: ui.issueGeneration, id: ui.selectedIssueId }
    return () => {
      assertChatIntent(intent)
      const current = store.get()
      if (!current.issueSheetOpen || current.issueGeneration !== selected.generation || current.selectedIssueId !== selected.id) throw new DOMException("Retired issue selection", "AbortError")
    }
  }, [owner, view, generation, ui.issueGeneration, ui.selectedIssueId, store])
  const issueQuery = useQuery({ ...workspaceIssueOptions(owner, ui.issueSheetOpen ? ui.selectedIssueId ?? "__none__" : "__none__"), enabled: ui.issueSheetOpen && !!ui.selectedIssueId, subscribed: ui.issueSheetOpen && !!ui.selectedIssueId })
  const pendingIssues = usePendingIssueChanges(owner)
  const issueDetail = useMemo(() => {
    const detail = issueQuery.data
    if (!detail) return null
    return pendingIssues.reduce((current, action) => action.kind === "update" && action.id === current.issue.id ? { ...current, issue: { ...current.issue, ...action.patch } } : current, detail)
  }, [issueQuery.data, pendingIssues])
  const issueConvId = issueDetail?.issue.conversation_id ?? null
  const issueTaskId = issueDetail?.issue.latest_task_id ?? null
  const traceId = issueDetail?.issue.trace_id ?? null
  const taskQuery = useQuery({ ...workspaceTaskOptions(owner, ui.issueSheetOpen ? issueTaskId ?? "__none__" : "__none__"), enabled: ui.issueSheetOpen && !!issueTaskId, subscribed: ui.issueSheetOpen && !!issueTaskId })
  const traceQuery = useQuery({ ...workspaceTraceOptions(owner, ui.issueSheetOpen ? traceId ?? "__none__" : "__none__"), enabled: ui.issueSheetOpen && !!traceId, subscribed: ui.issueSheetOpen && !!traceId })
  useEffect(() => {
    if (issueQuery.isFetching || !issueQuery.error || isAbortError(issueQuery.error) || isCancelledError(issueQuery.error)) return
    try { readSource() } catch { return }
    toast.error(issueQuery.error instanceof Error ? issueQuery.error.message : "Failed to load issue")
    setIssueSheetOpen(false)
  }, [issueQuery.error, issueQuery.isFetching, readSource, setIssueSheetOpen])
  const refetchIssue = issueQuery.refetch
  const openIssue = useCallback(async (issueId: string) => {
    assertChatIntent(captureChatIntent(owner, view))
    const current = store.get()
    const alreadyOpen = current.issueSheetOpen && current.selectedIssueId === issueId
    store.setState((state) => ({ ...state, selectedIssueId: issueId, issueSheetOpen: true, issueGeneration: state.issueGeneration + 1 }))
    if (alreadyOpen) void refetchIssue({ cancelRefetch: false })
  }, [owner, view, store, refetchIssue])
  useEffect(() => {
    const intent = captureChatIntent(owner, view)
    const timers: ReturnType<typeof setTimeout>[] = []
    const defer = (needed: boolean, clear: () => void) => {
      if (!needed) return
      timers.push(setTimeout(() => { try { assertChatIntent(intent); clear() } catch {} }, 300))
    }
    defer(!ui.artifactSheetOpen && !!selectedArtifact, () => setSelectedArtifact(null))
    defer(!ui.emailSheetOpen && !!ui.selectedEmailId, () => setSelectedEmailId(null))
    defer(!ui.calendarEventSheetOpen && !!ui.selectedCalendarEventId, () => setSelectedCalendarEventId(null))
    defer(!ui.issueSheetOpen && !!ui.selectedIssueId, () => setSelectedIssueId(null))
    return () => { for (const timer of timers) clearTimeout(timer) }
  }, [owner, view, ui, selectedArtifact, setSelectedArtifact, setSelectedEmailId, setSelectedCalendarEventId, setSelectedIssueId])
  const { mutateAsync: mutateIssue } = useIssueCommand(owner)
  const updateSelectedIssue = useCallback(async (issueId: string, patch: UpdateIssueRequest) => {
    const assertActive = capture()
    if (issueId !== store.get().selectedIssueId) return
    try { assertActive(); await mutateIssue({ action: { kind: "update", id: issueId, patch }, token: captureWorkspaceOwner(owner) }); assertActive() } catch (error) {
      if (isAbortError(error) || isCancelledError(error)) return
      try { assertActive() } catch { return }
      toast.error(error instanceof Error ? error.message : "Failed to update issue")
    }
  }, [owner, capture, store, mutateIssue])
  return { ...ui, setArtifactSheetOpen, selectedArtifact, setSelectedArtifact, setEmailSheetOpen, setSelectedEmailId, setCalendarEventSheetOpen, setSelectedCalendarEventId, setIssueSheetOpen, setSelectedIssueId,
    issueDetail, issueDetailLoading: issueQuery.isPending && ui.issueSheetOpen, issueTraceTasks: traceQuery.data?.tasks ?? null, issueActiveTask: taskQuery.data ?? null, openIssue, issueConvId, issueTaskId, updateSelectedIssue }
}
