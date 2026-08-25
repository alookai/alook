import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { afterEach, describe, expect, it } from "vitest"
import {
  addServiceProcess,
  applyHealthProbe,
  claimServiceFailure,
  cleanupLifecycle,
  createLifecycleState,
  failLifecycle,
  serviceFailureMessage,
  writeLifecycleState,
  type ServiceLifecycleState,
} from "./e2e-ui/_setup/service-lifecycle"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function healthyState(): ServiceLifecycleState {
  const state = addServiceProcess(createLifecycleState(true), {
    name: "web-ws-do",
    pid: 123,
    startedAt: new Date(0).toISOString(),
    healthUrl: "http://localhost:3000/api/health",
    expectedStatus: 200,
    expectedBody: { status: "ok" },
    logPath: "/tmp/web.log",
    internalLogDirectory: "/tmp/wrangler",
  })
  return { ...state, status: "healthy" }
}

describe("UI E2E service lifecycle", () => {
  it("tolerates a transient probe miss and fails after three misses spanning two seconds", () => {
    let state = applyHealthProbe(healthyState(), "web-ws-do", { ok: false, now: 1_000 })
    state = applyHealthProbe(state, "web-ws-do", { ok: true, now: 1_500 })
    expect(state.status).toBe("healthy")

    state = applyHealthProbe(state, "web-ws-do", { ok: false, now: 2_000 })
    state = applyHealthProbe(state, "web-ws-do", { ok: false, now: 3_000 })
    state = applyHealthProbe(state, "web-ws-do", { ok: false, now: 4_000 })

    expect(state.status).toBe("failed")
    expect(state.failure).toMatchObject({ service: "web-ws-do", kind: "health" })
  })

  it("records an unexpected close but ignores a close during cleanup", () => {
    const failure = {
      service: "web-ws-do",
      kind: "child-close" as const,
      at: new Date(0).toISOString(),
      code: 1,
      signal: null,
      detail: "managed service process closed unexpectedly",
    }

    const failed = failLifecycle(healthyState(), failure)
    expect(failed.status).toBe("failed")
    expect(serviceFailureMessage(failed)).toContain("code=1")
    expect(serviceFailureMessage(failed)).toContain("consoleLog=/tmp/web.log")
    expect(failLifecycle({ ...healthyState(), status: "stopping" }, failure).failure).toBeUndefined()
  })

  it("reports an infrastructure failure once and skips subsequent tests", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "alook-e2e-lifecycle-"))
    directories.push(directory)
    const statePath = resolve(directory, "state.json")
    const claimPath = resolve(directory, "failure.claim")
    writeLifecycleState(statePath, failLifecycle(healthyState(), {
      service: "web-ws-do",
      kind: "health",
      at: new Date(0).toISOString(),
      detail: "exact health failed",
    }))

    expect(claimServiceFailure(statePath, claimPath).action).toBe("report")
    expect(claimServiceFailure(statePath, claimPath).action).toBe("skip")
    writeLifecycleState(statePath, healthyState())
    expect(claimServiceFailure(statePath, claimPath)).toEqual({ action: "continue" })
  })

  it("terminates process groups, escalates, and restores state exactly once", async () => {
    const signals: string[] = []
    let waits = 0
    let restores = 0
    const dependencies = {
      terminate: (pid: number, signal: "SIGTERM" | "SIGKILL") => signals.push(`${pid}:${signal}`),
      waitForStop: async () => ++waits === 2,
      restore: () => { restores += 1 },
    }

    const stopped = await cleanupLifecycle(healthyState(), dependencies)
    const repeated = await cleanupLifecycle(stopped, dependencies)

    expect(signals).toEqual(["123:SIGTERM", "123:SIGKILL"])
    expect(restores).toBe(1)
    expect(repeated).toEqual(stopped)
  })

  it("cleans a partial setup after backup and child spawn before login completes", async () => {
    const starting = { ...healthyState(), status: "starting" as const }
    const signals: string[] = []
    let restores = 0

    const stopped = await cleanupLifecycle(starting, {
      terminate: (pid, signal) => signals.push(`${pid}:${signal}`),
      waitForStop: async () => true,
      restore: () => { restores += 1 },
    })

    expect(signals).toEqual(["123:SIGTERM"])
    expect(restores).toBe(1)
    expect(stopped).toMatchObject({ status: "stopped", restorePending: false })
  })
})
