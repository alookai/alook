import { test, type TestInfo } from "@playwright/test"
import { routeTemplate } from "@/lib/observability/coverage"
import { parseRetryAfterSeconds } from "@/lib/retry-after"

const DEFAULT_RETRY_DELAY_MS = 400
const PHASES = ["case-body", "case-cleanup", "actors", "fixture-read", "fixture-request", "history-profile", "seed-attempt", "retry-delay", "retry-wait", "scroll-server", "scroll-profile", "dm-profile", "scroll-case"] as const
type ClockPhase = typeof PHASES[number]
type ClockScope = { testId: string; file: string; workflowSha?: string }
type ClockFields = { method?: string; routeTemplate?: string; attempt?: number; status?: number; requestedWaitMs?: number; retryAfterSeconds?: number | null; durationMs?: number; outcome?: "passed" | "failed" }

export function fixtureClockScope(info?: Pick<TestInfo, "testId" | "file">): ClockScope | undefined {
  try {
    const current = info ?? test.info()
    const sha = process.env.GITHUB_SHA
    return { testId: current.testId, file: current.file, workflowSha: sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined }
  } catch { return undefined }
}

function clockStart(scope: ClockScope | undefined): number | undefined {
  try { return scope ? performance.now() : undefined } catch { return undefined }
}

function writeClock(scope: ClockScope | undefined, phase: ClockPhase, event: "start" | "end", fields: () => ClockFields) {
  if (!scope) return
  try {
    if (!PHASES.includes(phase)) return
    const value = fields()
    const record: Record<string, unknown> = {
      type: "alook:e2e:fixture-clock", testId: scope.testId, file: scope.file,
      workflowSha: scope.workflowSha && /^[0-9a-f]{40}$/i.test(scope.workflowSha) ? scope.workflowSha : undefined,
      phase, event, at: new Date().toISOString(),
    }
    for (const key of ["attempt", "status", "requestedWaitMs", "retryAfterSeconds", "durationMs"] as const) {
      if (typeof value[key] === "number" && Number.isFinite(value[key])) record[key] = value[key]
    }
    if (value.retryAfterSeconds === null) record.retryAfterSeconds = null
    if (value.method && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(value.method)) record.method = value.method
    if (typeof value.routeTemplate === "string") record.routeTemplate = routeTemplate(value.routeTemplate)
    if (value.outcome === "passed" || value.outcome === "failed") record.outcome = value.outcome
    console.log(JSON.stringify(record))
  } catch {}
}

export async function measureFixtureClock<T>(
  scope: ClockScope | undefined,
  phase: ClockPhase,
  operation: () => Promise<T>,
  fields: ClockFields = {},
  resultFields?: (value: T) => ClockFields,
): Promise<T> {
  if (!scope) return operation()
  const started = clockStart(scope)
  writeClock(scope, phase, "start", () => fields)
  try {
    const value = await operation()
    writeClock(scope, phase, "end", () => ({ ...fields, ...resultFields?.(value), durationMs: started === undefined ? undefined : performance.now() - started, outcome: "passed" }))
    return value
  } catch (error) {
    writeClock(scope, phase, "end", () => ({ ...fields, durationMs: started === undefined ? undefined : performance.now() - started, outcome: "failed" }))
    throw error
  }
}

export function isRetryableSeedStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500
}

export function seedRetryDelayMs(response: Pick<Response, "status" | "headers">, scope = fixtureClockScope()): number {
  const started = clockStart(scope)
  writeClock(scope, "retry-delay", "start", () => ({}))
  try {
    const status = response.status
    if (status !== 429) {
      writeClock(scope, "retry-delay", "end", () => ({ status, requestedWaitMs: DEFAULT_RETRY_DELAY_MS, durationMs: started === undefined ? undefined : performance.now() - started, outcome: "passed" }))
      return DEFAULT_RETRY_DELAY_MS
    }
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers)
    const delay = retryAfterSeconds === null ? DEFAULT_RETRY_DELAY_MS : retryAfterSeconds * 1000
    writeClock(scope, "retry-delay", "end", () => ({ status, retryAfterSeconds, requestedWaitMs: delay, durationMs: started === undefined ? undefined : performance.now() - started, outcome: "passed" }))
    return delay
  } catch (error) {
    writeClock(scope, "retry-delay", "end", () => ({ durationMs: started === undefined ? undefined : performance.now() - started, outcome: "failed" }))
    throw error
  }
}

export async function retrySeedRequest(
  request: () => Promise<Response>,
  wait: (delayMs: number) => Promise<void> = (delayMs) => (
    new Promise((resolve) => setTimeout(resolve, delayMs))
  ),
  scope = fixtureClockScope(),
): Promise<Response> {
  let response: Response | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await measureFixtureClock(scope, "seed-attempt", request, { attempt: attempt + 1 }, value => ({ status: value.status }))
    if (response.ok || !isRetryableSeedStatus(response.status)) return response
    if (attempt < 2) {
      const delay = seedRetryDelayMs(response, scope)
      await measureFixtureClock(scope, "retry-wait", () => wait(delay), { attempt: attempt + 1, requestedWaitMs: delay })
    }
  }
  return response!
}
