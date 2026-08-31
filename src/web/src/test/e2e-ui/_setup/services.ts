import { spawn, spawnSync, type ChildProcess } from "child_process"
import { createRequire } from "module"
import { closeSync, cpSync, existsSync, mkdirSync, openSync, rmSync } from "fs"
import { dirname, resolve } from "path"
import { REPO_ROOT, SERVICE_LOG_DIR, SERVICE_STATE_PATH, WEB_URL, WS_URL } from "./paths"
import {
  addServiceProcess,
  applyHealthProbe,
  cleanupLifecycle,
  failLifecycle,
  readLifecycleState,
  writeLifecycleState,
  type ServiceLifecycleState,
} from "./service-lifecycle"

export interface ManagedService {
  name: string
  proc: ChildProcess
  healthUrl: string
}

export interface ServiceDefinition {
  name: string
  command: string
  args: string[]
  healthUrl: string
  expectedStatus: number
  expectedBody: { status: "ok" }
}

export const E2E_WRANGLER_VERSION = "4.113.0"

export function resolveE2EWranglerRuntime(): {
  command: string
  entry: string
  version: string
} {
  const requireFromWeb = createRequire(resolve(REPO_ROOT, "src/web/package.json"))
  const packagePath = requireFromWeb.resolve("wrangler-e2e/package.json")
  const manifest = requireFromWeb(packagePath) as {
    version?: unknown
    bin?: unknown
  }
  const entry = typeof manifest.bin === "object" && manifest.bin !== null
    ? (manifest.bin as Record<string, unknown>).wrangler
    : undefined
  if (manifest.version !== E2E_WRANGLER_VERSION || typeof entry !== "string") {
    throw new Error(`invalid E2E Wrangler runtime at ${packagePath}`)
  }
  return {
    command: process.execPath,
    entry: resolve(dirname(packagePath), entry),
    version: manifest.version,
  }
}

export function wranglerLogEnvironment(internalLogDirectory: string): Record<
  "WRANGLER_LOG" | "WRANGLER_LOG_PATH" | "WRANGLER_LOG_SANITIZE",
  string
> {
  return {
    WRANGLER_LOG: "debug",
    WRANGLER_LOG_PATH: internalLogDirectory,
    WRANGLER_LOG_SANITIZE: "true",
  }
}

export function readinessExitMessage(
  service: string,
  exitCode: number | null,
  signalCode: NodeJS.Signals | null,
): string | null {
  return exitCode === null && signalCode === null
    ? null
    : `${service} exited before readiness (code ${exitCode}, signal ${signalCode})`
}

// Reuse a server the developer already has running (local iteration). CI
// always starts fresh. Migration-sensitive focused journeys may opt into the
// same fresh path locally; backupState/restoreState preserve developer data.
export const REUSE_EXISTING = !process.env.CI && !process.env.ALOOK_E2E_FORCE_FRESH
export const SINGLE_RUNTIME = !!process.env.CI

// Local D1/DO state that `db:reset` wipes. Backing it up to a sibling path
// (outside `.wrangler/state`, so `rm -rf .wrangler/state` can't touch it)
// lets a local run restore the developer's dev data on teardown. CI has no
// prior state, so backup/restore is a no-op there.
const STATE_DIR = resolve(REPO_ROOT, "src/web/.wrangler/state")
const STATE_BACKUP_DIR = resolve(REPO_ROOT, "src/web/.wrangler/state.e2e-backup")

// Returns true if a backup was taken (i.e. there was existing state to save).
export function backupState(): boolean {
  if (process.env.CI || !existsSync(STATE_DIR)) return false
  rmSync(STATE_BACKUP_DIR, { recursive: true, force: true })
  cpSync(STATE_DIR, STATE_BACKUP_DIR, { recursive: true })
  return true
}

export function restoreState(): void {
  if (!existsSync(STATE_BACKUP_DIR)) return
  rmSync(STATE_DIR, { recursive: true, force: true })
  cpSync(STATE_BACKUP_DIR, STATE_DIR, { recursive: true })
  rmSync(STATE_BACKUP_DIR, { recursive: true, force: true })
}

export async function hasExactHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number | null; detail: string }> {
  const timeoutMs = options.timeoutMs ?? 3_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("health probe timeout must be a positive finite number")
  }
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abortFromCaller()
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true })

  let deadline: ReturnType<typeof setTimeout> | undefined
  const timeoutResult = new Promise<{ ok: false; status: null; detail: string }>((resolveTimeout) => {
    deadline = setTimeout(() => {
      controller.abort(new Error(`health probe timed out after ${timeoutMs}ms`))
      resolveTimeout({ ok: false, status: null, detail: `health probe timed out after ${timeoutMs}ms` })
    }, timeoutMs)
  })
  const fetchResult = (async () => {
    try {
      const res = await fetchImpl(url, { signal: controller.signal })
      const body = await res.json().catch(() => null)
      const ok = res.status === 200
        && body !== null
        && typeof body === "object"
        && Object.keys(body).length === 1
        && (body as { status?: unknown }).status === "ok"
      return { ok, status: res.status, detail: ok ? "exact health matched" : `unexpected health payload ${JSON.stringify(body)}` }
    } catch (error) {
      return { ok: false, status: null, detail: error instanceof Error ? error.message : String(error) }
    }
  })()

  try {
    return await Promise.race([fetchResult, timeoutResult])
  } finally {
    if (deadline) clearTimeout(deadline)
    options.signal?.removeEventListener("abort", abortFromCaller)
    controller.abort()
  }
}

function childCloseRace(service: ManagedService, abortProbe: AbortController): {
  promise: Promise<never>
  cleanup: () => void
} {
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    rejectClose(new Error(
      readinessExitMessage(service.name, code, signal)
        ?? `${service.name} closed before readiness`,
    ))
    abortProbe.abort()
  }
  let rejectClose!: (reason: Error) => void
  const promise = new Promise<never>((_resolve, reject) => {
    rejectClose = reject
    service.proc.once("close", onClose)
  })
  return {
    promise,
    cleanup: () => service.proc.removeListener("close", onClose),
  }
}

export async function waitForHealth(
  service: ManagedService,
  timeoutMs = 90_000,
  fetchImpl: typeof fetch = fetch,
  probeTimeoutMs = 3_000,
): Promise<void> {
  const start = Date.now()
  // Date.now() is fine here — this runs in the Playwright config process
  // (node), not inside a workflow script.
  while (Date.now() - start < timeoutMs) {
    const exitMessage = readinessExitMessage(
      service.name,
      service.proc.exitCode,
      service.proc.signalCode,
    )
    if (exitMessage) throw new Error(exitMessage)
    const remainingMs = timeoutMs - (Date.now() - start)
    if (remainingMs <= 0) break
    const probeController = new AbortController()
    const close = childCloseRace(service, probeController)
    let result: Awaited<ReturnType<typeof hasExactHealth>>
    try {
      const subscribedExitMessage = readinessExitMessage(
        service.name,
        service.proc.exitCode,
        service.proc.signalCode,
      )
      if (subscribedExitMessage) throw new Error(subscribedExitMessage)
      result = await Promise.race([
        hasExactHealth(service.healthUrl, fetchImpl, {
          signal: probeController.signal,
          timeoutMs: Math.min(probeTimeoutMs, remainingMs),
        }),
        close.promise,
      ])
    } finally {
      close.cleanup()
      probeController.abort()
    }
    if (result.ok) return
    const delayMs = Math.min(1_000, timeoutMs - (Date.now() - start))
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error(`${service.name} not ready after ${timeoutMs}ms (${service.healthUrl})`)
}

export async function waitForServicesReady(
  services: ManagedService[],
  wait: (service: ManagedService, timeoutMs?: number) => Promise<void> = waitForHealth,
): Promise<void> {
  // Keep the callback unary. Passing waitForHealth directly to map would feed
  // the array index into its optional timeout argument (making service 0 fail
  // immediately with a zero-millisecond timeout).
  await Promise.all(services.map((service) => wait(service)))
}

export function prepareServices(): void {
  if (!SINGLE_RUNTIME) return
  const builds = [
    {
      name: "web worker",
      args: ["--filter", "@alook/web", "exec", "opennextjs-cloudflare", "build"],
    },
    {
      name: "Blog worker",
      args: ["--filter", "@alook/web", "build:blog"],
    },
  ]
  for (const build of builds) {
    const res = spawnSync("pnpm", build.args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        NEXT_PUBLIC_WS_DO_PORT: String(portOf(WEB_URL) ?? 3000),
      },
    })
    if (res.status !== 0) {
      throw new Error(`${build.name} build failed (exit ${res.status}, signal ${res.signal})`)
    }
  }
}

export function resetDb(): void {
  // `wrangler d1 migrations apply` prints the full migrations table (twice) on
  // every run — noise in CI when it succeeds. DROP stdout entirely (that table
  // is the noise) and capture only stderr so a real failure is still legible.
  //
  // Do NOT capture stdout into a buffer: it's ~600KB and blows spawnSync's 1MB
  // default `maxBuffer`, which kills the child (status=null) and made this whole
  // step falsely "fail" — crashing global-setup so CI never migrated and every
  // query 500'd. `stdio: ["ignore","ignore","pipe"]` can't overflow.
  const res = spawnSync("pnpm", ["run", "db:reset"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  })
  if (res.status !== 0) {
    if (res.stderr) process.stderr.write(res.stderr)
    throw new Error(`db:reset failed (exit ${res.status}, signal ${res.signal})`)
  }
}

function portOf(url: string): number | null {
  const p = Number(new URL(url).port)
  return Number.isFinite(p) && p > 0 ? p : null
}

// Best-effort: kill whatever is listening on the given TCP ports. Clears
// orphaned dev servers left by a prior run that crashed before teardown (e.g.
// global-setup failing after startServices). No-op on Windows / if lsof is
// absent. Only called when we're about to start fresh servers, never when
// reusing a healthy one.
function killPortOrphans(ports: number[]): void {
  if (process.platform === "win32") return
  for (const port of ports) {
    const res = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" })
    const pids = (res.stdout ?? "")
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
    for (const pid of pids) {
      const cwd = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf8",
      }).stdout
        ?.split("\n")
        .find((line) => line.startsWith("n"))
        ?.slice(1)
      if (!cwd || (cwd !== REPO_ROOT && !cwd.startsWith(`${REPO_ROOT}/`))) {
        console.warn(`Skipping listener ${pid} on port ${port}: it is not owned by this worktree`)
        continue
      }
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // already gone
      }
    }
  }
}

export function serviceDefinitions(singleRuntime: boolean): ServiceDefinition[] {
  const webHealth = `${WEB_URL}/api/health`
  const wsHealth = `${WS_URL}/health`
  if (!singleRuntime) {
    return [
      {
        name: "web",
        command: "pnpm",
        args: ["--filter", "@alook/web", "dev"],
        healthUrl: webHealth,
        expectedStatus: 200,
        expectedBody: { status: "ok" },
      },
      {
        name: "ws-do",
        command: "pnpm",
        args: ["--filter", "@alook/ws-do", "dev"],
        healthUrl: wsHealth,
        expectedStatus: 200,
        expectedBody: { status: "ok" },
      },
    ]
  }

  return [
    {
      name: "web-zones",
      command: "pnpm",
      args: ["--filter", "@alook/web", "dev:zones:worker"],
      healthUrl: webHealth,
      expectedStatus: 200,
      expectedBody: { status: "ok" },
    },
    {
      name: "ws-do",
      command: "pnpm",
      args: ["--filter", "@alook/ws-do", "dev"],
      healthUrl: "http://localhost:8789/health",
      expectedStatus: 200,
      expectedBody: { status: "ok" },
    },
  ]
}

function startService(definition: ServiceDefinition): ManagedService {
  const logPath = resolve(SERVICE_LOG_DIR, `${definition.name}.log`)
  const internalLogDirectory = resolve(SERVICE_LOG_DIR, `${definition.name}-wrangler-internal`)
  mkdirSync(internalLogDirectory, { recursive: true })
  const logFd = openSync(logPath, "a")
  try {
    const proc = spawn(definition.command, definition.args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", logFd, logFd],
      detached: true,
      env: {
        ...process.env,
        ...wranglerLogEnvironment(internalLogDirectory),
      },
    })
    if (!proc.pid) throw new Error(`${definition.name} did not expose a process ID`)
    const state = readLifecycleState(SERVICE_STATE_PATH)
    if (!state) throw new Error("service lifecycle state was not initialized")
    writeLifecycleState(SERVICE_STATE_PATH, addServiceProcess(state, {
      name: definition.name,
      pid: proc.pid,
      startedAt: new Date().toISOString(),
      healthUrl: definition.healthUrl,
      expectedStatus: definition.expectedStatus,
      expectedBody: definition.expectedBody,
      logPath,
      internalLogDirectory,
    }))
    proc.once("close", (code, signal) => {
      const current = readLifecycleState(SERVICE_STATE_PATH)
      if (!current) return
      writeLifecycleState(SERVICE_STATE_PATH, failLifecycle(current, {
        service: definition.name,
        kind: "child-close",
        at: new Date().toISOString(),
        code,
        signal,
        detail: "managed service process closed unexpectedly",
      }))
    })
    return { name: definition.name, proc, healthUrl: definition.healthUrl }
  } finally {
    closeSync(logFd)
  }
}

let healthSupervisor: ReturnType<typeof setInterval> | null = null
let healthProbeInFlight = false

export function stopHealthSupervisor(): void {
  if (healthSupervisor) clearInterval(healthSupervisor)
  healthSupervisor = null
  healthProbeInFlight = false
}

function startHealthSupervisor(services: ManagedService[]): void {
  stopHealthSupervisor()
  const probe = async () => {
    if (healthProbeInFlight) return
    healthProbeInFlight = true
    try {
      for (const service of services) {
        const result = await hasExactHealth(service.healthUrl)
        const state = readLifecycleState(SERVICE_STATE_PATH)
        if (!state) return
        const updated = applyHealthProbe(state, service.name, {
          ok: result.ok,
          now: Date.now(),
          healthStatus: result.status,
          detail: result.detail,
        })
        writeLifecycleState(SERVICE_STATE_PATH, updated)
        if (updated.status === "failed") {
          stopHealthSupervisor()
          return
        }
      }
    } finally {
      healthProbeInFlight = false
    }
  }
  healthSupervisor = setInterval(() => { void probe() }, 1_000)
  healthSupervisor.unref()
}

// Starts web (:3000) + ws-do (:8789). Realtime journeys REQUIRE ws-do, so a
// missing ws health check is a hard failure (fail fast), never a silent
// degrade. Returns started services (empty when reusing an existing server).
// `next dev` compiles each route lazily on first request, so a health check
// (which only proves the process is up) doesn't mean `/c/channels/...` is
// compiled. The first spec to hit a route then eats multi-second cold-compile
// time and its `waitForURL` can time out. Pre-hit the hot routes so they're
// warm before any spec runs.
async function warmUpRoutes(): Promise<void> {
  // Include the DYNAMIC route segments the first specs land on — `next dev`
  // compiles per route *file*, not per id, so a placeholder id triggers the
  // same compilation the real navigation needs. `/c/channels/x` (server root)
  // and `/c/channels/x/y` (channel) are the ones create-server waits for; the
  // server-root page also runs a data-gated redirect, so warming its chunk is
  // what keeps that first `waitForURL` from eating cold-compile time.
  const routes = ["/c", "/sign-in", "/c/me", "/c/channels/warmup", "/c/channels/warmup/warmup"]
  await Promise.all(routes.map(async (path) => {
    const response = await fetch(`${WEB_URL}${path}`, { redirect: "manual" })
    if (response.status >= 500) {
      throw new Error(`Route warm-up failed (${response.status} ${path})`)
    }
  }))
}

export async function startServices(): Promise<ManagedService[]> {
  const webHealth = `${WEB_URL}/api/health`
  const wsHealth = `${WS_URL}/health`

  if (REUSE_EXISTING && (await hasExactHealth(webHealth)).ok && (await hasExactHealth(wsHealth)).ok) {
    const state = readLifecycleState(SERVICE_STATE_PATH)
    if (state) writeLifecycleState(SERVICE_STATE_PATH, { ...state, status: "healthy" })
    await warmUpRoutes()
    return []
  }

  // Starting fresh — clear any orphaned dev servers on our ports first so a
  // prior crashed run doesn't leave 3000/8789 occupied (or get reused).
  const ports = (SINGLE_RUNTIME
    ? [portOf(WEB_URL), 3001, 3002, 8789]
    : [portOf(WEB_URL), portOf(WS_URL)])
    .filter((p): p is number => p != null)
  killPortOrphans(ports)
  // Give the OS a moment to release the sockets before we bind them.
  await new Promise((r) => setTimeout(r, 1000))
  rmSync(SERVICE_LOG_DIR, { recursive: true, force: true })
  mkdirSync(SERVICE_LOG_DIR, { recursive: true })

  const services = serviceDefinitions(SINGLE_RUNTIME).map(startService)

  await waitForServicesReady(services)
  const state = readLifecycleState(SERVICE_STATE_PATH)
  if (!state) throw new Error("service lifecycle state disappeared during readiness")
  if (state.failure) throw new Error(`service failed during readiness: ${state.failure.detail}`)
  writeLifecycleState(SERVICE_STATE_PATH, { ...state, status: "healthy" })
  startHealthSupervisor(services)
  await warmUpRoutes()
  return services
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessesToStop(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processGroupIsAlive(pid))) return true
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
  return pids.every((pid) => !processGroupIsAlive(pid))
}

export async function stopServicesAndRestore(): Promise<void> {
  stopHealthSupervisor()
  const state = readLifecycleState(SERVICE_STATE_PATH)
  if (!state || state.status === "stopped") return
  const stopping: ServiceLifecycleState = { ...state, status: "stopping" }
  writeLifecycleState(SERVICE_STATE_PATH, stopping)
  const stopped = await cleanupLifecycle(stopping, {
    terminate: (pid, signal) => {
      try {
        process.kill(process.platform === "win32" ? pid : -pid, signal)
      } catch {
        return
      }
    },
    waitForStop: waitForProcessesToStop,
    restore: restoreState,
  })
  writeLifecycleState(SERVICE_STATE_PATH, stopped)
}
