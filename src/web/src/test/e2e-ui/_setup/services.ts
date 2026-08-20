import { spawn, spawnSync, type ChildProcess } from "child_process"
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs"
import { resolve } from "path"
import { MANIFEST_PATH, REPO_ROOT, SERVICE_LOG_DIR, WEB_URL, WS_URL } from "./paths"

export interface ManagedService {
  name: string
  proc: ChildProcess
  healthUrl: string
}

export interface ServiceDefinition {
  name: string
  args: string[]
  healthUrl: string
}

export type RestorePolicy = "none" | "restore-backup" | "remove-created-state"

export interface PriorServiceManifest {
  servicePids: number[]
  restoreState: boolean
  restorePolicy: RestorePolicy
}

export interface ServiceLifecycleDecision {
  mode: "reuse" | "fresh"
  ci: boolean
  singleRuntime: boolean
  restoreState: boolean
  restorePolicy: RestorePolicy
}

export interface StatePaths {
  stateDir: string
  backupDir: string
  absentMarker: string
  manifestPath?: string | null
}

type RecoveryArtifact = "none" | "backup" | "absent"

export interface LifecycleDependencies {
  probeHealth: (url: string) => Promise<boolean>
  hasRecoveryArtifact: () => boolean
  recoveryArtifact: () => RecoveryArtifact
  stopOwnedAndWait: (pids: number[]) => Promise<void>
  assertPortsFree: (ports: number[]) => void
  restoreState: () => void
  backupState: () => Exclude<RestorePolicy, "none">
  resetDb: () => void
}

export interface StartServicesDependencies {
  clearLogs: () => void
  definitions: (singleRuntime: boolean) => ServiceDefinition[]
  startService: (definition: ServiceDefinition) => ManagedService
  waitForHealth: (url: string, name: string) => Promise<void>
  warmUpRoutes: () => Promise<void>
}

const SINGLE_RUNTIME = !!process.env.CI

// Local D1/DO state that `db:reset` wipes. Backing it up to a sibling path
// (outside `.wrangler/state`, so `rm -rf .wrangler/state` can't touch it)
// lets a local run restore the developer's dev data on teardown. CI has no
// prior state, so backup/restore is a no-op there.
const STATE_DIR = resolve(REPO_ROOT, "src/web/.wrangler/state")
const STATE_BACKUP_DIR = resolve(REPO_ROOT, "src/web/.wrangler/state.e2e-backup")
const STATE_ABSENT_MARKER = resolve(REPO_ROOT, "src/web/.wrangler/state.e2e-absent")

const DEFAULT_STATE_PATHS: StatePaths = {
  stateDir: STATE_DIR,
  backupDir: STATE_BACKUP_DIR,
  absentMarker: STATE_ABSENT_MARKER,
  manifestPath: MANIFEST_PATH,
}

function pendingPath(path: string): string {
  return `${path}.pending-${process.pid}`
}

export function recoveryArtifact(paths: StatePaths = DEFAULT_STATE_PATHS): RecoveryArtifact {
  const hasBackup = existsSync(paths.backupDir)
  const hasMarker = existsSync(paths.absentMarker)
  if (hasBackup && hasMarker) {
    throw new Error("E2E state recovery is ambiguous: backup and absence marker both exist")
  }
  if (hasBackup) return "backup"
  if (hasMarker) return "absent"
  return "none"
}

export function hasRecoveryArtifact(paths: StatePaths = DEFAULT_STATE_PATHS): boolean {
  return existsSync(paths.backupDir) || existsSync(paths.absentMarker)
}

function markManifestRestored(paths: StatePaths): void {
  const manifestPath = paths.manifestPath
  if (!manifestPath || !existsSync(manifestPath)) return
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  manifest.restoreState = false
  manifest.restorePolicy = "none"
  manifest.servicePids = []
  const stagingPath = pendingPath(manifestPath)
  writeFileSync(stagingPath, JSON.stringify(manifest, null, 2))
  renameSync(stagingPath, manifestPath)
}

// Publish exactly one durable recovery artifact before reset. A staging path
// keeps a failed copy/write from looking like a valid snapshot on the next run.
export function backupState(
  paths: StatePaths = DEFAULT_STATE_PATHS,
): Exclude<RestorePolicy, "none"> {
  if (recoveryArtifact(paths) !== "none") {
    throw new Error("E2E state recovery artifact already exists")
  }

  const backupStaging = pendingPath(paths.backupDir)
  const markerStaging = pendingPath(paths.absentMarker)
  rmSync(backupStaging, { recursive: true, force: true })
  rmSync(markerStaging, { force: true })

  if (existsSync(paths.stateDir)) {
    cpSync(paths.stateDir, backupStaging, { recursive: true })
    renameSync(backupStaging, paths.backupDir)
    return "restore-backup"
  }

  mkdirSync(resolve(paths.absentMarker, ".."), { recursive: true })
  writeFileSync(markerStaging, "state-was-absent\n")
  renameSync(markerStaging, paths.absentMarker)
  return "remove-created-state"
}

export function restoreState(paths: StatePaths = DEFAULT_STATE_PATHS): void {
  const artifact = recoveryArtifact(paths)
  if (artifact === "none") {
    throw new Error("E2E state restore was requested but no recovery artifact exists")
  }

  const manifest = paths.manifestPath && existsSync(paths.manifestPath)
    ? JSON.parse(readFileSync(paths.manifestPath, "utf8")) as Record<string, unknown>
    : null
  if (manifest?.restoreState === true) {
    const policy = manifest.restorePolicy
    let expectedArtifact: Exclude<RecoveryArtifact, "none">
    if (policy === undefined || policy === "restore-backup") {
      // The pre-policy runner only created a backup when restoreState was true.
      expectedArtifact = "backup"
    } else if (policy === "remove-created-state") {
      expectedArtifact = "absent"
    } else {
      throw new Error(`Invalid E2E restore policy: ${String(policy)}`)
    }
    if (expectedArtifact !== artifact) {
      throw new Error(
        `E2E restore policy ${String(policy)} contradicts ${artifact} recovery artifact`,
      )
    }
  }

  if (artifact === "backup") {
    const restoreStaging = pendingPath(paths.stateDir)
    rmSync(restoreStaging, { recursive: true, force: true })
    cpSync(paths.backupDir, restoreStaging, { recursive: true })
    rmSync(paths.stateDir, { recursive: true, force: true })
    renameSync(restoreStaging, paths.stateDir)
    markManifestRestored(paths)
    rmSync(paths.backupDir, { recursive: true, force: true })
    return
  }

  rmSync(paths.stateDir, { recursive: true, force: true })
  markManifestRestored(paths)
  rmSync(paths.absentMarker, { force: true })
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url)
    return res.status < 500
  } catch {
    return false
  }
}

async function waitForHealth(url: string, name: string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now()
  // Date.now() is fine here — this runs in the Playwright config process
  // (node), not inside a workflow script.
  while (Date.now() - start < timeoutMs) {
    if (await isUp(url)) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`${name} not ready after ${timeoutMs}ms (${url})`)
}

function parseOwnedPids(value: unknown): number[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw new Error("Invalid servicePids in prior E2E manifest")
  }
  return [...new Set(value as number[])]
}

export function readPriorServiceManifest(path = MANIFEST_PATH): PriorServiceManifest | null {
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  const restoreStateRequested = value.restoreState === true
  const rawPolicy = value.restorePolicy
  let restorePolicy: RestorePolicy = "none"
  if (
    rawPolicy === "none"
    || rawPolicy === "restore-backup"
    || rawPolicy === "remove-created-state"
  ) {
    restorePolicy = rawPolicy
  } else if (rawPolicy === undefined && restoreStateRequested) {
    // Older manifests only carried the boolean. The durable artifact remains
    // authoritative about whether prior state was present or absent.
    restorePolicy = "restore-backup"
  } else if (rawPolicy !== undefined) {
    throw new Error(`Invalid restorePolicy in prior E2E manifest: ${String(rawPolicy)}`)
  }
  if (restoreStateRequested && restorePolicy === "none") {
    throw new Error("Prior E2E manifest requests restore with restorePolicy=none")
  }
  if (!restoreStateRequested && restorePolicy !== "none") {
    throw new Error("Prior E2E manifest has a restore policy while restoreState=false")
  }
  return {
    servicePids: parseOwnedPids(value.servicePids),
    restoreState: restoreStateRequested,
    restorePolicy,
  }
}

export function prepareServices(): void {
  if (!SINGLE_RUNTIME) return
  const res = spawnSync(
    "pnpm",
    ["--filter", "@alook/web", "exec", "opennextjs-cloudflare", "build"],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        NEXT_PUBLIC_WS_DO_PORT: String(portOf(WEB_URL) ?? 3000),
      },
    },
  )
  if (res.status !== 0) {
    throw new Error(`web worker build failed (exit ${res.status}, signal ${res.signal})`)
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

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

export async function stopOwnedProcessGroups(pids: number[], timeoutMs = 10_000): Promise<void> {
  if (process.platform === "win32" && pids.length > 0) {
    throw new Error("Stopping detached E2E process groups is unsupported on Windows")
  }
  for (const pid of [...new Set(pids)]) {
    try {
      process.kill(-pid, "SIGTERM")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }

  const deadline = Date.now() + timeoutMs
  while (pids.some(processGroupAlive)) {
    if (Date.now() >= deadline) {
      throw new Error(`Owned E2E process groups did not stop: ${pids.join(",")}`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
}

export function assertPortsFree(ports: number[]): void {
  if (process.platform === "win32") return
  for (const port of ports) {
    const res = spawnSync(
      "lsof",
      ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf8" },
    )
    if (res.error) throw res.error
    const pids = (res.stdout ?? "")
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
    if (pids.length > 0) {
      throw new Error(`Runner port ${port} is occupied by an unowned process (${pids.join(",")})`)
    }
  }
}

function runnerPorts(singleRuntime: boolean): number[] {
  return (singleRuntime ? [portOf(WEB_URL)] : [portOf(WEB_URL), portOf(WS_URL)])
    .filter((port): port is number => port != null)
}

const DEFAULT_LIFECYCLE_DEPENDENCIES: LifecycleDependencies = {
  probeHealth: isUp,
  hasRecoveryArtifact: () => hasRecoveryArtifact(),
  recoveryArtifact: () => recoveryArtifact(),
  stopOwnedAndWait: stopOwnedProcessGroups,
  assertPortsFree,
  restoreState: () => restoreState(),
  backupState: () => backupState(),
  resetDb,
}

function restoreAfterFailure(dependencies: LifecycleDependencies, error: unknown): never {
  try {
    dependencies.restoreState()
  } catch (restoreError) {
    throw new AggregateError([error, restoreError], "E2E setup failed and state restore also failed")
  }
  throw error
}

export async function prepareServiceLifecycle(
  priorManifest: PriorServiceManifest | null,
  options: { ci?: boolean; singleRuntime?: boolean } = {},
  dependencies: LifecycleDependencies = DEFAULT_LIFECYCLE_DEPENDENCIES,
): Promise<ServiceLifecycleDecision> {
  const ci = options.ci ?? !!process.env.CI
  const singleRuntime = options.singleRuntime ?? ci
  if (ci) {
    dependencies.resetDb()
    return {
      mode: "fresh",
      ci: true,
      singleRuntime,
      restoreState: false,
      restorePolicy: "none",
    }
  }

  const [webHealthy, wsHealthy] = await Promise.all([
    dependencies.probeHealth(`${WEB_URL}/api/health`),
    dependencies.probeHealth(`${WS_URL}/health`),
  ])
  const recoveryPending = priorManifest?.restoreState === true
    || dependencies.hasRecoveryArtifact()
  if (webHealthy && wsHealthy && !recoveryPending) {
    return {
      mode: "reuse",
      ci: false,
      singleRuntime,
      restoreState: false,
      restorePolicy: "none",
    }
  }

  await dependencies.stopOwnedAndWait(priorManifest?.servicePids ?? [])
  dependencies.assertPortsFree(runnerPorts(singleRuntime))

  const artifact = dependencies.recoveryArtifact()
  if (priorManifest?.restoreState && artifact === "none") {
    throw new Error("Prior E2E manifest requires restore but its recovery artifact is missing")
  }
  if (priorManifest?.restoreState) {
    const expectedArtifact = priorManifest.restorePolicy === "restore-backup"
      ? "backup"
      : priorManifest.restorePolicy === "remove-created-state"
        ? "absent"
        : null
    if (!expectedArtifact) {
      throw new Error("Prior E2E manifest requires restore but has no restore policy")
    }
    if (expectedArtifact !== artifact) {
      throw new Error(
        `Prior E2E restore policy ${priorManifest.restorePolicy} contradicts ${artifact} artifact`,
      )
    }
  }
  if (artifact !== "none") dependencies.restoreState()

  const restorePolicy = dependencies.backupState()
  try {
    dependencies.resetDb()
  } catch (error) {
    restoreAfterFailure(dependencies, error)
  }
  return {
    mode: "fresh",
    ci: false,
    singleRuntime,
    restoreState: true,
    restorePolicy,
  }
}

export async function cleanupFailedSetup(
  decision: ServiceLifecycleDecision,
  ownedPids: number[],
  dependencies: Pick<
    LifecycleDependencies,
    "stopOwnedAndWait" | "assertPortsFree" | "restoreState"
  > = DEFAULT_LIFECYCLE_DEPENDENCIES,
): Promise<void> {
  if (ownedPids.length > 0 || decision.restoreState) {
    await dependencies.stopOwnedAndWait(ownedPids)
    dependencies.assertPortsFree(runnerPorts(decision.singleRuntime))
  }
  if (decision.restoreState) dependencies.restoreState()
}

export function serviceDefinitions(singleRuntime: boolean): ServiceDefinition[] {
  const webHealth = `${WEB_URL}/api/health`
  const wsHealth = `${WS_URL}/health`
  if (!singleRuntime) {
    return [
      { name: "web", args: ["--filter", "@alook/web", "dev"], healthUrl: webHealth },
      { name: "ws-do", args: ["--filter", "@alook/ws-do", "dev"], healthUrl: wsHealth },
    ]
  }

  return [{
    name: "web-ws-do",
    args: [
      "exec",
      "wrangler",
      "dev",
      "-c",
      "src/web/wrangler.toml",
      "-c",
      "src/ws-do/wrangler.toml",
      "--persist-to",
      "src/web/.wrangler/state",
      "--port",
      String(portOf(WEB_URL) ?? 3000),
      "--local",
      "--show-interactive-dev-session=false",
    ],
    healthUrl: webHealth,
  }]
}

function startService(definition: ServiceDefinition): ManagedService {
  const logFd = openSync(resolve(SERVICE_LOG_DIR, `${definition.name}.log`), "a")
  try {
    const proc = spawn("pnpm", definition.args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    })
    return { name: definition.name, proc, healthUrl: definition.healthUrl }
  } finally {
    closeSync(logFd)
  }
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

const DEFAULT_START_DEPENDENCIES: StartServicesDependencies = {
  clearLogs: () => {
    rmSync(SERVICE_LOG_DIR, { recursive: true, force: true })
    mkdirSync(SERVICE_LOG_DIR, { recursive: true })
  },
  definitions: serviceDefinitions,
  startService,
  waitForHealth,
  warmUpRoutes,
}

export async function startServices(
  decision: ServiceLifecycleDecision,
  onOwnershipChanged: (services: ManagedService[]) => void = () => undefined,
  dependencies: StartServicesDependencies = DEFAULT_START_DEPENDENCIES,
): Promise<ManagedService[]> {
  if (decision.mode === "reuse") {
    await dependencies.warmUpRoutes()
    return []
  }

  dependencies.clearLogs()
  const services: ManagedService[] = []
  for (const definition of dependencies.definitions(decision.singleRuntime)) {
    services.push(dependencies.startService(definition))
    onOwnershipChanged([...services])
  }

  await Promise.all(
    services.map((service) => dependencies.waitForHealth(service.healthUrl, service.name)),
  )
  await dependencies.warmUpRoutes()
  return services
}
