import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import {
  BUG_REPORT_POLL_INTERVAL_MS,
  bugReportFailureMessage,
  bugReportsFeatureEnabled,
  buildBugReportCreateRequest,
  buildBugReportStatusRequest,
  bugReportReducer,
  initialBugReportState,
  projectOwnerBugReport,
  shouldPollBugReport,
  startBugReportAttempt,
  useBotBugReport,
} from "./use-bot-bug-report"

const apiFetchMock = vi.fn()

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type BugReportHookResult = ReturnType<typeof useBotBugReport>

function renderBugReportHook(initialOpen = true) {
  const result: { current: BugReportHookResult } = { current: null as never }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })

  function Probe({ open }: { open: boolean }) {
    result.current = useBotBugReport({ agentId: "bot_1", open })
    return null
  }

  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Probe, { open: initialOpen }),
      ),
    )
  })

  return {
    queryClient,
    renderer,
    result,
    setOpen(open: boolean) {
      act(() => {
        renderer.update(
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(Probe, { open }),
          ),
        )
      })
    },
  }
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function pendingReport(nowMs = Date.now()) {
  return {
    reportId: "dbr_pending",
    status: "pending",
    deadlineAt: nowMs + 600_000,
    completedAt: null,
    failureCode: null,
    objectExpired: false,
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000001",
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("bug-report frontend adapter", () => {
  it("enables the entry only for an exact top-level true capability", () => {
    expect(bugReportsFeatureEnabled(undefined)).toBe(false)
    expect(bugReportsFeatureEnabled({ bots: [], features: {} })).toBe(false)
    expect(bugReportsFeatureEnabled({ bots: [], features: { bugReports: false } })).toBe(false)
    expect(bugReportsFeatureEnabled({ bots: [], features: { bugReports: "true" } })).toBe(false)
    expect(bugReportsFeatureEnabled({ bots: [], features: { bugReports: true } })).toBe(true)
  })

  it("locks the POST and GET owner-route shapes without a real route", () => {
    expect(buildBugReportCreateRequest("bot_1", "00000000-0000-4000-8000-000000000001")).toEqual({
      path: "/api/community/bots/bot_1/diagnostics",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientNonce: "00000000-0000-4000-8000-000000000001" }),
      },
    })
    expect(buildBugReportStatusRequest("dbr_test123")).toEqual({
      path: "/api/community/diagnostics/dbr_test123",
      init: { method: "GET" },
    })
  })

  it("projects only owner-visible status fields and drops storage and machine metadata", () => {
    const projected = projectOwnerBugReport({
      reportId: "dbr_test123",
      status: "uploaded",
      deadlineAt: 2_000,
      completedAt: 1_500,
      failureCode: null,
      objectExpired: false,
      machineId: "cm_private",
      objectKey: "reports/dbr_test123.ndjson.gz",
      objectExpiresAt: 3_000,
      expiresAt: 3_000,
      url: "https://example.invalid/report",
      downloadUrl: "https://example.invalid/download",
      sha256: "a".repeat(64),
      checksum: "secret-metadata",
    })

    expect(projected).toEqual({
      reportId: "dbr_test123",
      status: "uploaded",
      deadlineAt: 2_000,
      completedAt: 1_500,
      failureCode: null,
      objectExpired: false,
    })
    expect(JSON.stringify(projected)).not.toMatch(/machine|objectKey|url|sha|checksum/i)
  })

  it.each([
    ["offline", "Bring the daemon online, then try again."],
    ["timeout", "Collection timed out. Try again."],
    ["upload_conflict", "The report could not be uploaded safely. Try again."],
    ["invalid_upload", "The report upload was rejected. Try again."],
    ["diagnostics_unavailable", "Diagnostics are unavailable right now. Try again."],
    ["collector_busy", "Another report is being collected. Try again shortly."],
    ["bot_not_bound", "This bot is no longer available on that machine."],
    ["collection_failed", "Diagnostics could not be collected. Try again."],
    ["local_artifact_invalid", "The local diagnostic bundle could not be verified."],
    ["bundle_too_large", "The diagnostic bundle was too large to upload."],
    ["upload_failed", "The report upload failed. Try again."],
    ["internal_error", "The report could not be completed. Try again."],
  ])("maps %s to fixed safe copy", (code, expected) => {
    expect(bugReportFailureMessage(code)).toBe(expected)
  })

  it("uses one fixed generic message for unknown codes instead of reflecting arbitrary detail", () => {
    expect(bugReportFailureMessage("Bearer secret /Users/private")).toBe(
      "The report could not be completed. Try again.",
    )
  })
})

describe("bug-report client state", () => {
  it("generates one UUID per logical attempt and ignores double confirmation", () => {
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")

    const first = startBugReportAttempt(initialBugReportState, randomUUID)
    const doubleConfirm = startBugReportAttempt(first, randomUUID)
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(doubleConfirm).toEqual(first)
  })

  it("reuses the nonce after an ambiguous POST failure and adopts an existing pending id", () => {
    const started = {
      ...initialBugReportState,
      phase: "submitting" as const,
      clientNonce: "nonce-stable",
    }
    const ambiguous = bugReportReducer(started, { type: "create_error" })
    expect(ambiguous).toMatchObject({
      phase: "failed",
      terminal: false,
      clientNonce: "nonce-stable",
      reportId: null,
    })

    const randomUUID = vi.fn(() => "nonce-new")
    const retry = startBugReportAttempt(ambiguous, randomUUID)
    expect(randomUUID).not.toHaveBeenCalled()
    expect(retry.clientNonce).toBe("nonce-stable")

    const collecting = bugReportReducer(retry, {
      type: "created",
      delivery: "unknown",
      report: {
        reportId: "dbr_existing_pending",
        status: "pending",
        deadlineAt: 5_000,
        completedAt: null,
        failureCode: null,
        objectExpired: false,
      },
    })
    expect(collecting).toMatchObject({
      phase: "collecting",
      terminal: false,
      clientNonce: "nonce-stable",
      reportId: "dbr_existing_pending",
    })
  })

  it("keeps the report id and collecting phase across polling failure", () => {
    const collecting = {
      ...initialBugReportState,
      phase: "collecting" as const,
      clientNonce: "nonce-1",
      reportId: "dbr_1",
      deadlineAt: 5_000,
    }
    expect(bugReportReducer(collecting, { type: "poll_error" })).toMatchObject({
      phase: "collecting",
      reportId: "dbr_1",
      clientNonce: "nonce-1",
    })
  })

  it("maps uploaded/failed/timeout and stops polling at terminal, close, or deadline", () => {
    const collecting = {
      ...initialBugReportState,
      phase: "collecting" as const,
      clientNonce: "nonce-1",
      reportId: "dbr_1",
      deadlineAt: 5_000,
    }
    const uploaded = bugReportReducer(collecting, {
      type: "status",
      report: { reportId: "dbr_1", status: "uploaded", deadlineAt: 5_000, completedAt: 2_000, failureCode: null, objectExpired: false },
    })
    const failed = bugReportReducer(collecting, {
      type: "status",
      report: { reportId: "dbr_1", status: "failed", deadlineAt: 5_000, completedAt: 2_000, failureCode: "offline", objectExpired: false },
    })
    const timeout = bugReportReducer(collecting, {
      type: "status",
      report: { reportId: "dbr_1", status: "failed", deadlineAt: 5_000, completedAt: 5_000, failureCode: "timeout", objectExpired: false },
    })

    expect(uploaded).toMatchObject({ phase: "uploaded", terminal: true })
    expect(failed).toMatchObject({ phase: "failed", terminal: true })
    expect(timeout).toMatchObject({ phase: "timeout", terminal: true })
    expect(shouldPollBugReport(collecting, { open: true, nowMs: 4_999 })).toBe(true)
    expect(shouldPollBugReport(collecting, { open: false, nowMs: 4_999 })).toBe(false)
    expect(shouldPollBugReport(collecting, { open: true, nowMs: 5_000 })).toBe(false)
    expect(shouldPollBugReport(uploaded, { open: true, nowMs: 2_001 })).toBe(false)
    expect(shouldPollBugReport(failed, { open: true, nowMs: 2_001 })).toBe(false)
    expect(shouldPollBugReport(timeout, { open: true, nowMs: 5_001 })).toBe(false)
  })

  it("creates a fresh UUID only for an explicit new attempt after confirmed terminal", () => {
    const failed = {
      ...initialBugReportState,
      phase: "failed" as const,
      terminal: true,
      clientNonce: "nonce-old",
      reportId: "dbr_old",
      failureCode: "offline",
    }
    const randomUUID = vi.fn(() => "nonce-new")
    const next = startBugReportAttempt(failed, randomUUID)
    expect(randomUUID).toHaveBeenCalledTimes(1)
    expect(next).toMatchObject({
      phase: "submitting",
      terminal: false,
      clientNonce: "nonce-new",
      reportId: null,
    })
  })
})

describe("useBotBugReport", () => {
  it("turns two synchronous confirms into one POST with one nonce", async () => {
    let resolveCreate!: (value: unknown) => void
    apiFetchMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )

    const { renderer, result } = renderBugReportHook()
    act(() => {
      void result.current.confirm()
      void result.current.confirm()
    })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/bots/bot_1/diagnostics",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          clientNonce: "00000000-0000-4000-8000-000000000001",
        }),
      }),
    )

    resolveCreate({ report: { ...pendingReport(), status: "uploaded", completedAt: 2_000 } })
    await flushMicrotasks()
    renderer.unmount()
  })

  it("retries an ambiguous POST with the same nonce, then polls the adopted pending id", async () => {
    apiFetchMock
      .mockRejectedValueOnce(new TypeError("connection dropped"))
      .mockResolvedValueOnce({ report: pendingReport(), delivery: "unknown" })
      .mockResolvedValueOnce({ report: pendingReport() })

    const { renderer, result } = renderBugReportHook()
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.state).toMatchObject({ phase: "failed", terminal: false })

    await act(async () => {
      await result.current.confirm()
    })
    await flushMicrotasks()

    const postCalls = apiFetchMock.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === "POST",
    )
    expect(postCalls).toHaveLength(2)
    expect(postCalls[0]?.[1]).toMatchObject(postCalls[1]?.[1] as RequestInit)
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1)
    expect(result.current.state).toMatchObject({
      phase: "collecting",
      reportId: "dbr_pending",
      clientNonce: "00000000-0000-4000-8000-000000000001",
    })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/diagnostics/dbr_pending",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    )

    act(() => {
      void result.current.confirm()
    })
    expect(apiFetchMock.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === "POST",
    )).toHaveLength(2)
    renderer.unmount()
  })

  it("aborts the exact in-flight status query and stops polling when the dialog closes", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let statusSignal: AbortSignal | undefined
    apiFetchMock
      .mockResolvedValueOnce({ report: pendingReport(), delivery: "accepted" })
      .mockImplementationOnce((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
        statusSignal = init.signal as AbortSignal
        statusSignal.addEventListener("abort", () => reject(new Error("aborted")))
      }))

    const hook = renderBugReportHook()
    const cancelQueries = vi.spyOn(hook.queryClient, "cancelQueries")
    await act(async () => {
      await hook.result.current.confirm()
    })
    await vi.waitFor(() => expect(statusSignal).toBeDefined())

    hook.setOpen(false)
    expect(cancelQueries).toHaveBeenCalledWith({
      queryKey: communityKeys.bugReport("dbr_pending"),
      exact: true,
    })
    expect(statusSignal?.aborted).toBe(true)
    const getCount = apiFetchMock.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === "GET",
    ).length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(apiFetchMock.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === "GET",
    )).toHaveLength(getCount)
    hook.renderer.unmount()
  })

  it("aborts the exact in-flight status query on unmount", async () => {
    let statusSignal: AbortSignal | undefined
    apiFetchMock
      .mockResolvedValueOnce({ report: pendingReport(), delivery: "accepted" })
      .mockImplementationOnce((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
        statusSignal = init.signal as AbortSignal
        statusSignal.addEventListener("abort", () => reject(new Error("aborted")))
      }))

    const hook = renderBugReportHook()
    const cancelQueries = vi.spyOn(hook.queryClient, "cancelQueries")
    await act(async () => {
      await hook.result.current.confirm()
    })
    await vi.waitFor(() => expect(statusSignal).toBeDefined())

    act(() => hook.renderer.unmount())
    expect(cancelQueries).toHaveBeenCalledWith({
      queryKey: communityKeys.bugReport("dbr_pending"),
      exact: true,
    })
    expect(statusSignal?.aborted).toBe(true)
  })

  it("refetches only while the adopted report remains collecting", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    apiFetchMock
      .mockResolvedValueOnce({ report: pendingReport(), delivery: "accepted" })
      .mockResolvedValue({ report: pendingReport() })

    const hook = renderBugReportHook()
    await act(async () => {
      await hook.result.current.confirm()
    })
    await flushMicrotasks()
    expect(apiFetchMock.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === "GET",
    )).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BUG_REPORT_POLL_INTERVAL_MS)
    })
    expect(apiFetchMock.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === "GET",
    )).toHaveLength(2)
    hook.renderer.unmount()
  })

  it.each([
    ["uploaded", null, "uploaded"],
    ["failed", "timeout", "timeout"],
  ] as const)("does not poll again after %s becomes terminal", async (status, failureCode, phase) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    apiFetchMock
      .mockResolvedValueOnce({ report: pendingReport(), delivery: "accepted" })
      .mockResolvedValueOnce({
        report: {
          ...pendingReport(),
          status,
          failureCode,
          completedAt: 2_000,
        },
      })

    const hook = renderBugReportHook()
    await act(async () => {
      await hook.result.current.confirm()
    })
    await flushMicrotasks()
    expect(hook.result.current.state.phase).toBe(phase)

    const getCount = apiFetchMock.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === "GET",
    ).length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(apiFetchMock.mock.calls.filter(([, init]) =>
      (init as RequestInit | undefined)?.method === "GET",
    )).toHaveLength(getCount)
    hook.renderer.unmount()
  })

  it("fails closed on malformed owner payload without reflecting unknown fields", async () => {
    apiFetchMock.mockResolvedValueOnce({
      report: {
        reportId: "dbr_hostile",
        status: "provider-secret-status",
        deadlineAt: 60_000,
        completedAt: null,
        failureCode: "Bearer secret /Users/private",
        detail: "raw provider detail must not render",
        objectExpired: false,
      },
    })

    const hook = renderBugReportHook()
    await act(async () => {
      await hook.result.current.confirm()
    })
    await flushMicrotasks()

    expect(hook.result.current.state).toMatchObject({
      phase: "failed",
      terminal: true,
      failureCode: "internal_error",
    })
    expect(bugReportFailureMessage(hook.result.current.state.failureCode)).toBe(
      "The report could not be completed. Try again.",
    )
    expect(JSON.stringify(hook.result.current.state)).not.toMatch(
      /provider-secret-status|Bearer secret|Users\/private|raw provider detail/,
    )
    hook.renderer.unmount()
  })
})
