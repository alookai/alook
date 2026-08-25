import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs"

export type ServiceLifecycleStatus = "starting" | "healthy" | "failed" | "stopping" | "stopped"

export interface ServiceProcessState {
  name: string
  pid?: number
  startedAt: string
  healthUrl: string
  expectedStatus: number
  expectedBody: { status: "ok" }
  logPath: string
  internalLogDirectory: string
}

export interface ServiceFailure {
  service: string
  kind: "child-close" | "health"
  at: string
  code?: number | null
  signal?: NodeJS.Signals | null
  healthStatus?: number | null
  detail: string
}

export interface ServiceLifecycleState {
  status: ServiceLifecycleStatus
  restorePending: boolean
  services: ServiceProcessState[]
  health: Record<string, { consecutiveFailures: number; firstFailureAt?: number }>
  failure?: ServiceFailure
}

export function createLifecycleState(restorePending = false): ServiceLifecycleState {
  return { status: "starting", restorePending, services: [], health: {} }
}

export function readLifecycleState(path: string): ServiceLifecycleState | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf8")) as ServiceLifecycleState
}

export function writeLifecycleState(path: string, state: ServiceLifecycleState): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(temporary, path)
}

export function addServiceProcess(
  state: ServiceLifecycleState,
  service: ServiceProcessState,
): ServiceLifecycleState {
  return {
    ...state,
    services: [...state.services.filter((entry) => entry.name !== service.name), service],
    health: {
      ...state.health,
      [service.name]: { consecutiveFailures: 0 },
    },
  }
}

export function failLifecycle(
  state: ServiceLifecycleState,
  failure: ServiceFailure,
): ServiceLifecycleState {
  if (state.status === "stopping" || state.status === "stopped" || state.failure) return state
  return { ...state, status: "failed", failure }
}

export function applyHealthProbe(
  state: ServiceLifecycleState,
  service: string,
  probe: { ok: boolean; now: number; healthStatus?: number | null; detail?: string },
): ServiceLifecycleState {
  if (state.status !== "healthy") return state
  const current = state.health[service] ?? { consecutiveFailures: 0 }
  if (probe.ok) {
    return {
      ...state,
      health: { ...state.health, [service]: { consecutiveFailures: 0 } },
    }
  }
  const next = {
    consecutiveFailures: current.consecutiveFailures + 1,
    firstFailureAt: current.firstFailureAt ?? probe.now,
  }
  const updated = { ...state, health: { ...state.health, [service]: next } }
  if (next.consecutiveFailures < 3 || probe.now - next.firstFailureAt < 2_000) return updated
  return failLifecycle(updated, {
    service,
    kind: "health",
    at: new Date(probe.now).toISOString(),
    healthStatus: probe.healthStatus,
    detail: probe.detail ?? "three consecutive exact health probes failed",
  })
}

export function serviceFailureMessage(state: ServiceLifecycleState): string {
  const failure = state.failure
  if (!failure) return "UI E2E infrastructure failure"
  const service = state.services.find((entry) => entry.name === failure.service)
  return [
    `UI E2E infrastructure failure: ${failure.service} ${failure.kind}`,
    `code=${failure.code ?? "none"}`,
    `signal=${failure.signal ?? "none"}`,
    `healthStatus=${failure.healthStatus ?? "none"}`,
    `detail=${failure.detail}`,
    `consoleLog=${service?.logPath ?? "unknown"}`,
    `internalLogs=${service?.internalLogDirectory ?? "unknown"}`,
  ].join("; ")
}

export type FailureDecision = { action: "continue" } | { action: "report" | "skip"; message: string }

export function claimServiceFailure(statePath: string, claimPath: string): FailureDecision {
  const state = readLifecycleState(statePath)
  if (!state?.failure) return { action: "continue" }
  const message = serviceFailureMessage(state)
  try {
    const descriptor = openSync(claimPath, "wx")
    closeSync(descriptor)
    return { action: "report", message }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { action: "skip", message }
    throw error
  }
}

export async function cleanupLifecycle(
  state: ServiceLifecycleState,
  dependencies: {
    terminate: (pid: number, signal: "SIGTERM" | "SIGKILL") => void
    waitForStop: (pids: number[], timeoutMs: number) => Promise<boolean>
    restore: () => void
  },
): Promise<ServiceLifecycleState> {
  if (state.status === "stopped") return state
  const stopping: ServiceLifecycleState = { ...state, status: "stopping" }
  const pids = stopping.services
    .map((service) => service.pid)
    .filter((pid): pid is number => Number.isInteger(pid) && Number(pid) > 0)
  for (const pid of pids) dependencies.terminate(pid, "SIGTERM")
  if (!(await dependencies.waitForStop(pids, 5_000))) {
    for (const pid of pids) dependencies.terminate(pid, "SIGKILL")
    if (!(await dependencies.waitForStop(pids, 2_000))) {
      throw new Error(`E2E services did not stop: ${pids.join(", ")}`)
    }
  }
  if (stopping.restorePending) dependencies.restore()
  return { ...stopping, status: "stopped", restorePending: false }
}
