"use client"

import { useEffect } from "react"
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query"
import { useCreateStore, useSelector } from "@tanstack/react-store"
import { useCommunityViewSource } from "./use-community-view-source"
import { useCommunityMutationOrigin } from "./community-origin"

import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import {
  DiagnosticReportFailureCodeSchema,
  type DiagnosticReportFailureCode,
} from "@alook/shared"

export const BUG_REPORT_POLL_INTERVAL_MS = 1_000
const BUG_REPORT_GC_TIME_MS = 5 * 60_000

const CLIENT_ERROR_CODES = [
  "rate_limited",
  "target_unavailable",
  "nonce_conflict",
  "network_error",
] as const

type BugReportClientErrorCode = (typeof CLIENT_ERROR_CODES)[number]

export type BugReportUiErrorCode = DiagnosticReportFailureCode | BugReportClientErrorCode

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
  failureCode: DiagnosticReportFailureCode | null
  objectExpired: boolean
}

export type BugReportState = {
  phase: BugReportPhase
  terminal: boolean
  clientNonce: string | null
  reportId: string | null
  deadlineAt: number | null
  completedAt: number | null
  errorCode: BugReportUiErrorCode | null
  objectExpired: boolean
}

export const initialBugReportState: BugReportState = {
  phase: "confirm",
  terminal: false,
  clientNonce: null,
  reportId: null,
  deadlineAt: null,
  completedAt: null,
  errorCode: null,
  objectExpired: false,
}

type CreateBugReportFailureAction =
  | { type: "create_error" }
  | { type: "create_rejected"; code: BugReportClientErrorCode }

type BugReportAction =
  | CreateBugReportFailureAction
  | { type: "poll_error" }
  | { type: "invalid_payload" }
  | { type: "deadline" }
  | { type: "created"; delivery: "accepted" | "unknown"; report: OwnerBugReport }
  | { type: "status"; report: OwnerBugReport }

const errorMessages: Record<BugReportUiErrorCode, string> = {
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
  rate_limited: "You can send another report in a minute.",
  target_unavailable: "Diagnostics aren't available for this bot right now.",
  nonce_conflict: "That report already belongs to another bot. Try again.",
  network_error: "Unable to connect — check your network",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isServerFailureCode(value: unknown): value is DiagnosticReportFailureCode {
  return DiagnosticReportFailureCodeSchema.safeParse(value).success
}

function isClientErrorCode(value: unknown): value is BugReportClientErrorCode {
  return typeof value === "string"
    && (CLIENT_ERROR_CODES as readonly string[]).includes(value)
}

function isUiErrorCode(value: unknown): value is BugReportUiErrorCode {
  return isClientErrorCode(value) || isServerFailureCode(value)
}

export function createActionFromApiError(error: unknown): CreateBugReportFailureAction {
  if (error instanceof ApiError) {
    if (error.isNetworkError || error.status === 0) {
      return { type: "create_rejected", code: "network_error" }
    }
    if (error.isRateLimit) return { type: "create_rejected", code: "rate_limited" }
    if (error.status === 404) return { type: "create_rejected", code: "target_unavailable" }
    if (error.status === 409) return { type: "create_rejected", code: "nonce_conflict" }
  }
  return { type: "create_error" }
}

function isCreateRejectedTerminal(code: BugReportClientErrorCode): boolean {
  return code === "rate_limited" || code === "nonce_conflict"
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
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
  if (value.failureCode !== null && value.failureCode !== undefined && !isServerFailureCode(value.failureCode)) {
    return null
  }
  if (value.status === "failed" && !isServerFailureCode(value.failureCode)) return null
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

export function bugReportErrorMessage(code: unknown): string {
  return isUiErrorCode(code) ? errorMessages[code] : errorMessages.internal_error
}

export function startBugReportAttempt(
  state: BugReportState,
  randomUUID: () => string = () => globalThis.crypto.randomUUID(),
): BugReportState {
  if (state.phase === "submitting" || state.phase === "collecting") return state
  if (!state.terminal && state.clientNonce) {
    return { ...state, phase: "submitting", errorCode: null }
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
    errorCode: report.failureCode,
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
    return { ...state, phase: "failed", terminal: false, errorCode: "internal_error" }
  }
  if (action.type === "create_rejected") {
    return {
      ...state,
      phase: "failed",
      terminal: isCreateRejectedTerminal(action.code),
      errorCode: action.code,
    }
  }
  if (action.type === "invalid_payload") {
    return { ...state, phase: "failed", terminal: true, errorCode: "internal_error" }
  }
  if (action.type === "deadline") {
    return { ...state, phase: "timeout", terminal: true, errorCode: "timeout" }
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

class InvalidBugReportPayloadError extends Error {}

export function useBotBugReport({ agentId, open }: { agentId: string; open: boolean }) {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  const source = useCommunityViewSource(`bug-report:${agentId}`)
  const attempt = useCreateStore({ nonce: null as string | null, expiredReportId: null as string | null })
  const intent = useSelector(attempt, (state) => state)
  const createKey = ["community", "bug-report-create", agentId] as const
  const creation = useMutation({
    mutationKey: createKey,
    mutationFn: async ({ nonce, token, assert }: { nonce: string; token: ReturnType<typeof origin.begin>["token"]; assert: ReturnType<typeof source.capture> }) => {
      assert()
      const request = buildBugReportCreateRequest(agentId, nonce)
      const response = await origin.request<unknown>(token, request.path, { ...request.init, signal: assert.signal, assertActive: assert })
      assert()
      const report = reportFromEnvelope(response)
      if (!report) throw new InvalidBugReportPayloadError("Invalid diagnostics response")
      const key = communityKeys.bugReport(report.reportId)
      const resource = queryClient.getQueryCache().build<OwnerBugReport>(queryClient, { queryKey: key, gcTime: BUG_REPORT_GC_TIME_MS })
      if (!resource.state.data) resource.setData(report)
      origin.assert(token)
      return { nonce, reportId: report.reportId }
    },
  })
  const resetCreation = creation.reset
  const reportId = creation.data?.nonce === intent.nonce ? creation.data.reportId : null
  const polling = open && !!reportId && intent.expiredReportId !== reportId
  const statusQuery = useQuery<OwnerBugReport>({
    queryKey: communityKeys.bugReport(reportId ?? "inactive"), subscribed: polling,
    gcTime: BUG_REPORT_GC_TIME_MS,
    enabled: (query) => polling && query.state.data?.status === "pending" && Date.now() < query.state.data.deadlineAt && !(query.state.error instanceof InvalidBugReportPayloadError),
    retry: false,
    queryFn: async ({ signal }) => {
      const token = origin.begin().token
      const request = buildBugReportStatusRequest(reportId!)
      const response = await origin.request<unknown>(token, request.path, { ...request.init, signal })
      origin.assert(token)
      const report = reportFromEnvelope(response)
      if (!report) throw new InvalidBugReportPayloadError("Invalid diagnostics response")
      return report
    },
    refetchInterval: (query) => {
      const report = query.state.data
      return polling && !(query.state.error instanceof InvalidBugReportPayloadError) && report?.status === "pending" && Date.now() < report.deadlineAt ? BUG_REPORT_POLL_INTERVAL_MS : false
    },
  })
  let state: BugReportState = { ...initialBugReportState, clientNonce: intent.nonce }
  if (creation.variables?.nonce === intent.nonce) {
    if (creation.isPending) state = { ...state, phase: "submitting" }
    else if (creation.error && !(creation.error instanceof DOMException && creation.error.name === "AbortError")) {
      state = bugReportReducer(state, creation.error instanceof InvalidBugReportPayloadError ? { type: "invalid_payload" } : createActionFromApiError(creation.error))
    }
  }
  if (statusQuery.data && statusQuery.data.reportId === reportId) state = stateForReport(state, statusQuery.data)
  if (statusQuery.error instanceof InvalidBugReportPayloadError) state = bugReportReducer(state, { type: "invalid_payload" })
  if (intent.expiredReportId === reportId && state.phase === "collecting") state = bugReportReducer(state, { type: "deadline" })
  useEffect(() => {
    const report = statusQuery.data
    if (!open || !report || report.status !== "pending") return
    const assert = source.capture()
    const expire = () => {
      try { assert() } catch { return }
      attempt.setState((state) => ({ ...state, expiredReportId: report.reportId }))
    }
    const remaining = report.deadlineAt - Date.now()
    if (remaining <= 0) { expire(); return }
    const timer = setTimeout(expire, remaining)
    return () => clearTimeout(timer)
  }, [open, statusQuery.data, source, attempt])
  useEffect(() => {
    if (open || !state.terminal) return
    attempt.setState(() => ({ nonce: null, expiredReportId: null }))
    resetCreation()
  }, [open, state.terminal, attempt, resetCreation])
  const confirm = async () => {
    if (state.phase === "submitting" || state.phase === "collecting") return
    if (queryClient.getMutationCache().findAll({ mutationKey: createKey, status: "pending" }).length) return
    try {
      const assert = source.capture(), token = origin.begin().token
      assert()
      const started = startBugReportAttempt({ ...state, clientNonce: attempt.get().nonce })
      if (!started.clientNonce) return
      attempt.setState(() => ({ nonce: started.clientNonce, expiredReportId: null }))
      await creation.mutateAsync({ nonce: started.clientNonce, token, assert })
    }
    catch {}
  }
  return { state, confirm }
}
