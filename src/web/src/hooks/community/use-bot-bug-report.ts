"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

export const BUG_REPORT_POLL_INTERVAL_MS = 1_000

const FAILURE_CODES = [
  "offline",
  "timeout",
  "upload_conflict",
  "invalid_upload",
  "diagnostics_unavailable",
  "collector_busy",
  "bot_not_bound",
  "collection_failed",
  "local_artifact_invalid",
  "bundle_too_large",
  "upload_failed",
  "internal_error",
] as const

export type BugReportFailureCode = (typeof FAILURE_CODES)[number]
export type BugReportPhase =
  | "confirm"
  | "submitting"
  | "collecting"
  | "uploaded"
  | "failed"
  | "timeout"

export type OwnerBugReport = {
  reportId: string
  status: "pending" | "uploaded" | "failed"
  deadlineAt: number
  completedAt: number | null
  failureCode: BugReportFailureCode | null
  objectExpired: boolean
}

export type BugReportState = {
  phase: BugReportPhase
  terminal: boolean
  clientNonce: string | null
  reportId: string | null
  deadlineAt: number | null
  completedAt: number | null
  failureCode: BugReportFailureCode | null
  objectExpired: boolean
}

export const initialBugReportState: BugReportState = {
  phase: "confirm",
  terminal: false,
  clientNonce: null,
  reportId: null,
  deadlineAt: null,
  completedAt: null,
  failureCode: null,
  objectExpired: false,
}

type BugReportAction =
  | { type: "create_error" }
  | { type: "poll_error" }
  | { type: "invalid_payload" }
  | { type: "deadline" }
  | { type: "created"; delivery: "accepted" | "unknown"; report: OwnerBugReport }
  | { type: "status"; report: OwnerBugReport }

const failureMessages: Record<BugReportFailureCode, string> = {
  offline: "Bring the daemon online, then try again.",
  timeout: "Collection timed out. Try again.",
  upload_conflict: "The report could not be uploaded safely. Try again.",
  invalid_upload: "The report upload was rejected. Try again.",
  diagnostics_unavailable: "Diagnostics are unavailable right now. Try again.",
  collector_busy: "Another report is being collected. Try again shortly.",
  bot_not_bound: "This bot is no longer available on that machine.",
  collection_failed: "Diagnostics could not be collected. Try again.",
  local_artifact_invalid: "The local diagnostic bundle could not be verified.",
  bundle_too_large: "The diagnostic bundle was too large to upload.",
  upload_failed: "The report upload failed. Try again.",
  internal_error: "The report could not be completed. Try again.",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFailureCode(value: unknown): value is BugReportFailureCode {
  return typeof value === "string" && (FAILURE_CODES as readonly string[]).includes(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function bugReportsFeatureEnabled(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.features)) return false
  return value.features.bugReports === true
}

export function buildBugReportCreateRequest(agentId: string, clientNonce: string) {
  return {
    path: `/api/community/bots/${agentId}/diagnostics`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientNonce }),
    },
  }
}

export function buildBugReportStatusRequest(reportId: string) {
  return {
    path: `/api/community/diagnostics/${reportId}`,
    init: { method: "GET" },
  }
}

export function projectOwnerBugReport(value: unknown): OwnerBugReport | null {
  if (!isRecord(value)) return null
  if (typeof value.reportId !== "string" || !value.reportId.startsWith("dbr_")) return null
  if (value.status !== "pending" && value.status !== "uploaded" && value.status !== "failed") {
    return null
  }
  if (!isTimestamp(value.deadlineAt) || typeof value.objectExpired !== "boolean") return null
  if (value.completedAt !== null && value.completedAt !== undefined && !isTimestamp(value.completedAt)) {
    return null
  }
  if (value.failureCode !== null && value.failureCode !== undefined && !isFailureCode(value.failureCode)) {
    return null
  }
  if (value.status === "failed" && !isFailureCode(value.failureCode)) return null
  if (value.status !== "failed" && value.failureCode !== null && value.failureCode !== undefined) {
    return null
  }

  return {
    reportId: value.reportId,
    status: value.status,
    deadlineAt: value.deadlineAt,
    completedAt: value.completedAt ?? null,
    failureCode: value.failureCode ?? null,
    objectExpired: value.objectExpired,
  }
}

export function bugReportFailureMessage(code: unknown): string {
  return isFailureCode(code) ? failureMessages[code] : failureMessages.internal_error
}

export function startBugReportAttempt(
  state: BugReportState,
  randomUUID: () => string = () => globalThis.crypto.randomUUID(),
): BugReportState {
  if (state.phase === "submitting" || state.phase === "collecting") return state
  if (!state.terminal && state.clientNonce) {
    return { ...state, phase: "submitting", failureCode: null }
  }
  return {
    ...initialBugReportState,
    phase: "submitting",
    clientNonce: randomUUID(),
  }
}

function stateForReport(state: BugReportState, report: OwnerBugReport): BugReportState {
  const shared = {
    ...state,
    reportId: report.reportId,
    deadlineAt: report.deadlineAt,
    completedAt: report.completedAt,
    failureCode: report.failureCode,
    objectExpired: report.objectExpired,
  }
  if (report.status === "pending") {
    return { ...shared, phase: "collecting", terminal: false }
  }
  if (report.status === "uploaded") {
    return { ...shared, phase: "uploaded", terminal: true }
  }
  return {
    ...shared,
    phase: report.failureCode === "timeout" ? "timeout" : "failed",
    terminal: true,
  }
}

export function bugReportReducer(state: BugReportState, action: BugReportAction): BugReportState {
  if (action.type === "created" || action.type === "status") {
    return stateForReport(state, action.report)
  }
  if (action.type === "create_error") {
    return { ...state, phase: "failed", terminal: false, failureCode: "internal_error" }
  }
  if (action.type === "invalid_payload") {
    return { ...state, phase: "failed", terminal: true, failureCode: "internal_error" }
  }
  if (action.type === "deadline") {
    return { ...state, phase: "timeout", terminal: true, failureCode: "timeout" }
  }
  return state
}

export function shouldPollBugReport(
  state: BugReportState,
  options: { open: boolean; nowMs: number },
): boolean {
  return Boolean(
    options.open &&
      state.phase === "collecting" &&
      state.reportId &&
      state.deadlineAt !== null &&
      options.nowMs < state.deadlineAt,
  )
}

function reportFromEnvelope(value: unknown): OwnerBugReport | null {
  if (!isRecord(value)) return null
  return projectOwnerBugReport(value.report)
}

export function useBotBugReport({ agentId, open }: { agentId: string; open: boolean }) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<BugReportState>(initialBugReportState)
  const stateRef = useRef(state)
  const mountedRef = useRef(true)

  const replaceState = useCallback((next: BugReportState) => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
  }, [])

  const apply = useCallback((action: BugReportAction) => {
    let next = bugReportReducer(stateRef.current, action)
    if (
      (action.type === "created" || action.type === "status") &&
      next.phase === "collecting" &&
      next.deadlineAt !== null &&
      Date.now() >= next.deadlineAt
    ) {
      next = bugReportReducer(next, { type: "deadline" })
    }
    replaceState(next)
  }, [replaceState])

  const confirm = useCallback(async () => {
    const current = stateRef.current
    const started = startBugReportAttempt(current)
    if (started === current) return
    replaceState(started)

    const request = buildBugReportCreateRequest(agentId, started.clientNonce!)
    try {
      const response = await apiFetch<unknown>(request.path, request.init)
      const report = reportFromEnvelope(response)
      if (!report) {
        apply({ type: "invalid_payload" })
        return
      }
      const delivery = isRecord(response) && response.delivery === "accepted"
        ? "accepted"
        : "unknown"
      apply({ type: "created", delivery, report })
    } catch {
      apply({ type: "create_error" })
    }
  }, [agentId, apply, replaceState])

  const reportId = state.reportId
  const polling = Boolean(open && state.phase === "collecting" && reportId)
  const statusQuery = useQuery({
    queryKey: communityKeys.bugReport(reportId ?? "inactive"),
    enabled: polling,
    retry: false,
    queryFn: async ({ signal }) => {
      const request = buildBugReportStatusRequest(reportId!)
      const response = await apiFetch<unknown>(request.path, { ...request.init, signal })
      const report = reportFromEnvelope(response)
      if (report) apply({ type: "status", report })
      else apply({ type: "invalid_payload" })
      return report
    },
  })
  const refetchStatus = statusQuery.refetch
  const statusErrorUpdatedAt = statusQuery.errorUpdatedAt

  useEffect(() => {
    if (!polling) return
    const interval = globalThis.setInterval(() => {
      if (shouldPollBugReport(stateRef.current, { open, nowMs: Date.now() })) {
        void refetchStatus()
      } else {
        apply({ type: "deadline" })
      }
    }, BUG_REPORT_POLL_INTERVAL_MS)
    return () => globalThis.clearInterval(interval)
  }, [apply, open, polling, refetchStatus])

  useEffect(() => {
    if (statusErrorUpdatedAt) apply({ type: "poll_error" })
  }, [apply, statusErrorUpdatedAt])

  useEffect(() => {
    if (state.phase !== "collecting" || state.deadlineAt === null) return
    const remaining = state.deadlineAt - Date.now()
    if (remaining <= 0) {
      apply({ type: "deadline" })
      return
    }
    const timeout = globalThis.setTimeout(() => apply({ type: "deadline" }), remaining)
    return () => globalThis.clearTimeout(timeout)
  }, [apply, state.deadlineAt, state.phase])

  useEffect(() => {
    if (open || !reportId) return
    void queryClient.cancelQueries({
      queryKey: communityKeys.bugReport(reportId),
      exact: true,
    })
  }, [open, queryClient, reportId])

  useEffect(() => {
    if (!reportId) return
    return () => {
      void queryClient.cancelQueries({
        queryKey: communityKeys.bugReport(reportId),
        exact: true,
      })
    }
  }, [queryClient, reportId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  return { state, confirm }
}
