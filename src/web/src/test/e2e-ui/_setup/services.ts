import { spawn, spawnSync, type ChildProcess } from "child_process"
import { createRequire } from "module"
import { createHash } from "node:crypto"
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import { assertPublicStaticWriteSeparation, canonicalPhasePath, readPhaseFile, readPublicStaticManifest } from "../../../../scripts/dev-zone-processes.mjs"
import { AUTH_DIR, QUEUE_URL, REPO_ROOT, resolveWsUrl, SERVICE_LOG_DIR, SERVICE_STATE_PATH, SINGLE_RUNTIME, WEB_URL } from "./paths"
import {
  addServiceProcess,
  applyHealthProbe,
  cleanupLifecycle,
  failLifecycle,
  readLifecycleState,
  writeLifecycleState,
  phaseReadinessFailure,
  phaseProbeCrossed,
  type PublicStaticPhaseReceipt,
  type ServiceLifecycleState,
} from "./service-lifecycle"

export function publicStaticQaManifest(verify = true) {
  const forensics = process.env.ALOOK_E2E_PUBLIC_STATIC_FORENSICS
  if (forensics !== undefined && forensics !== "1") throw new Error("Invalid public static forensic opt-in")
  if (forensics === "1" && process.env.ALOOK_PUBLIC_STATIC_QA !== "1") throw new Error("Public static forensics requires supplementary QA")
  const file = process.env.ALOOK_E2E_RELEASE_MANIFEST
  if (process.env.ALOOK_PUBLIC_STATIC_QA === "1" && !file) throw new Error("Supplementary public static QA requires ALOOK_E2E_RELEASE_MANIFEST")
  if (!file) return null
  if (process.env.ALOOK_PUBLIC_STATIC_QA !== "1" || process.env.ALOOK_E2E_PREBUILT !== "1") throw new Error("Release phases require explicit supplementary QA and prebuilt inputs")
  if (canonicalPhasePath(file).startsWith(`${canonicalPhasePath(AUTH_DIR)}/`)) throw new Error("Release input manifest must survive the ordinary auth-directory reset")
  const manifest = readPublicStaticManifest(file, AUTH_DIR, verify)
  if (manifest.defaultRelease !== "Nplus1") throw new Error("The complete candidate QA run requires Nplus1 as its default release")
  assertPublicStaticWriteSeparation(manifest, [AUTH_DIR, STATE_DIR, STATE_BACKUP_DIR, SERVICE_LOG_DIR, resolve(REPO_ROOT, "src/web/blog/.wrangler/state"), resolve(REPO_ROOT, ".wrangler/registry")])
  return manifest
}

export function capturePublicStaticRuntimeState(options: { runtimeRoot: string; ownerRoot: string; controlDirectory: string; runId: string; manifestDigest: string }) {
  const owner = canonicalPhasePath(options.ownerRoot)
  const control = canonicalPhasePath(options.controlDirectory)
  if (!control.startsWith(`${owner}/`)) throw new Error("Forensic output must belong to the case owner")
  const target = resolve(control, "forensics-stopped-state")
  const roots = ["src/web/.wrangler/state", "src/web/blog/.wrangler/state", "src/web/e2e-service-logs", ".wrangler/registry"]
  const sources = roots.map(path => ({ path, absolute: resolve(options.runtimeRoot, path) }))
  for (const source of sources) {
    const actual = canonicalPhasePath(source.absolute)
    if (target === actual || target.startsWith(`${actual}/`) || actual.startsWith(`${target}/`)) throw new Error("Forensic state and output overlap")
    let parent = source.absolute
    while (parent !== resolve(options.runtimeRoot)) {
      if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Forensic state cannot contain symlinks")
      parent = dirname(parent)
    }
  }
  if (lstatSync(target, { throwIfNoEntry: false })) throw new Error("Forensic output already exists")
  mkdirSync(target, { mode: 0o700 })
  const files: Array<{ path: string; type: "file" | "directory"; mode: number; bytes?: number; sha256?: string }> = []
  const copy = (source: string, relative: string) => {
    const stat = lstatSync(source)
    const destination = resolve(target, relative)
    if (stat.isSymbolicLink()) throw new Error("Forensic state cannot contain symlinks")
    if (stat.isDirectory()) {
      mkdirSync(destination, { recursive: true, mode: 0o700 })
      for (const name of readdirSync(source).sort()) copy(resolve(source, name), `${relative}/${name}`)
      chmodSync(destination, stat.mode & 0o777)
      files.push({ path: relative, type: "directory", mode: stat.mode & 0o777 })
    } else if (stat.isFile()) {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      const body = readFileSync(source)
      const sha256 = createHash("sha256").update(body).digest("hex")
      writeFileSync(destination, body, { flag: "wx", mode: stat.mode & 0o777 })
      chmodSync(destination, stat.mode & 0o777)
      if (createHash("sha256").update(readFileSync(source)).digest("hex") !== sha256 || createHash("sha256").update(readFileSync(destination)).digest("hex") !== sha256) throw new Error("Forensic state changed during capture")
      files.push({ path: relative, type: "file", mode: stat.mode & 0o777, bytes: body.length, sha256 })
    } else throw new Error("Forensic state contains an unsupported entry")
  }
  const presence = sources.map(source => {
    const present = !!lstatSync(source.absolute, { throwIfNoEntry: false })
    if (present) copy(source.absolute, source.path)
    return { path: source.path, present }
  })
  const receipt = { schema: 1, runId: options.runId, manifestDigest: options.manifestDigest, at: new Date().toISOString(), qualification: "Stopped terminal state before original restoration, not an in-flight snapshot or proof of native trace completeness", sources: presence, files }
  writeFileSync(resolve(target, "capture.private.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  return receipt
}

export async function cleanupWithPublicStaticEvidence(state: ServiceLifecycleState, dependencies: Parameters<typeof cleanupLifecycle>[1] & { capture: () => void; persist: (state: ServiceLifecycleState) => void }) {
  if (state.status === "stopped") return state
  let attempted = false
  let captureFailed = false
  let captureFailure: unknown
  const capture = () => {
    if (attempted) return
    attempted = true
    try { dependencies.capture() } catch (error) { captureFailed = true; captureFailure = error }
  }
  let stopped: ServiceLifecycleState
  try {
    stopped = await cleanupLifecycle(state, { ...dependencies, restore: () => { capture(); dependencies.restore() } })
  } catch (error) {
    if (captureFailed) throw new AggregateError([error, captureFailure], "Original cleanup and forensic capture failed")
    throw error
  }
  if (!state.restorePending) capture()
  try { dependencies.persist(stopped) } catch (error) {
    if (captureFailed) throw new AggregateError([error, captureFailure], "Lifecycle persistence and forensic capture failed")
    throw error
  }
  if (captureFailed) throw captureFailure
  return stopped
}

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

export const E2E_PREBUILT_ENTRYPOINTS = [
  "src/web/.open-next/worker.js",
  "src/web/blog/.open-next/worker.js",
] as const

export function resolveE2EWranglerRuntime(): {
  command: string
  entry: string
  version: string
} {
  const requireFromWeb = createRequire(resolve(REPO_ROOT, "src/web/package.json"))
  const packagePath = requireFromWeb.resolve("wrangler/package.json")
  const manifest = requireFromWeb(packagePath) as {
    version?: unknown
    bin?: unknown
  }
  const entry = typeof manifest.bin === "object" && manifest.bin !== null
    ? (manifest.bin as Record<string, unknown>).wrangler
    : undefined
  if (
    typeof manifest.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
    || typeof entry !== "string"
  ) {
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

export { SINGLE_RUNTIME } from "./paths"

const STATE_DIR = resolve(REPO_ROOT, "src/web/.wrangler/state")
const STATE_BACKUP_DIR = resolve(REPO_ROOT, "src/web/.wrangler/state.e2e-backup")

function backupState(): void {
  const state = readLifecycleState(SERVICE_STATE_PATH)
  if (!state) throw new Error("service lifecycle state was not initialized")
  if (process.env.CI) return
  if (lstatSync(STATE_BACKUP_DIR, { throwIfNoEntry: false })) throw new Error(`unresolved E2E state backup: ${STATE_BACKUP_DIR}`)
  if (state.restorePending) throw new Error("E2E state restoration is already pending")
  const original = lstatSync(STATE_DIR, { throwIfNoEntry: false })
  if (!original) return
  if (!original.isDirectory()) throw new Error("E2E local state must be a directory")
  writeLifecycleState(SERVICE_STATE_PATH, { ...state, restorePending: true })
  try {
    renameSync(STATE_DIR, STATE_BACKUP_DIR)
  } catch (error) {
    writeLifecycleState(SERVICE_STATE_PATH, state)
    throw error
  }
}

export function restoreState(): void {
  if (!lstatSync(STATE_BACKUP_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("E2E state backup must be a directory during restoration")
  }
  rmSync(STATE_DIR, { recursive: true, force: true })
  renameSync(STATE_BACKUP_DIR, STATE_DIR)
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

export function serviceBuildCommands(
  singleRuntime = SINGLE_RUNTIME,
  prebuilt = process.env.ALOOK_E2E_PREBUILT === "1",
  root = REPO_ROOT,
): Array<{ name: string; args: string[] }> {
  if (!singleRuntime) return []
  if (prebuilt) {
    for (const entrypoint of E2E_PREBUILT_ENTRYPOINTS) {
      const path = resolve(root, entrypoint)
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new Error(`prebuilt OpenNext worker entrypoint is missing: ${path}`)
      }
    }
    return []
  }
  return [
    {
      name: "web worker",
      args: ["--filter", "@alook/web", "exec", "opennextjs-cloudflare", "build"],
    },
    {
      name: "Blog worker",
      args: ["--filter", "@alook/web", "build:blog"],
    },
  ]
}

export function prepareServices(): void {
  const phaseManifest = publicStaticQaManifest()
  const builds = phaseManifest ? [] : serviceBuildCommands()
  backupState()
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

function resetDb(): void {
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

export function serviceDefinitions(singleRuntime = SINGLE_RUNTIME): ServiceDefinition[] {
  const webHealth = `${WEB_URL}/api/health`
  if (!singleRuntime) {
    const wsHealth = `${resolveWsUrl({
      webUrl: WEB_URL,
      explicitWsUrl: process.env.DEV_WS_DO_URL,
      singleRuntime,
    })}/health`
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
      {
        name: "queue-worker",
        command: "pnpm",
        args: ["--filter", "@alook/queue-worker", "dev"],
        healthUrl: `${QUEUE_URL}/health`,
        expectedStatus: 200,
        expectedBody: { status: "ok" },
      },
    ]
  }

  const runtime = resolveE2EWranglerRuntime()
  const phaseManifest = publicStaticQaManifest(false)
  return [{
    name: "web-zones",
    command: "pnpm",
    args: [
      "--filter",
      "@alook/web",
      "dev:zones:worker",
      "--with-ws-do",
      "--wrangler-entry",
      runtime.entry,
      ...(phaseManifest ? ["--public-static-manifest", resolve(process.env.ALOOK_E2E_RELEASE_MANIFEST!), "--public-static-owner-root", AUTH_DIR] : []),
    ],
    healthUrl: webHealth,
    expectedStatus: 200,
    expectedBody: { status: "ok" },
  }]
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
        const manifest = publicStaticQaManifest(false)
        let sample: PublicStaticPhaseReceipt | undefined
        const readExpectedPhase = () => {
          const value = readPhaseFile(resolve(manifest!.controlDirectory, "receipt.json")) as PublicStaticPhaseReceipt | null
          const failure = phaseReadinessFailure(value, Date.now())
          if (failure || value?.runId !== manifest!.runId || value.manifestDigest !== manifest!.digest) throw new Error(failure ?? "Public static phase receipt has a foreign identity")
          return value
        }
        if (manifest) {
          readExpectedPhase()
          const stable = await hasExactHealth("http://127.0.0.1:8789/health")
          if (!stable.ok) {
            const current = readLifecycleState(SERVICE_STATE_PATH)
            if (current) writeLifecycleState(SERVICE_STATE_PATH, failLifecycle(current, { service: "stable-ws-queue", kind: "health", at: new Date().toISOString(), detail: stable.detail }))
            stopHealthSupervisor()
            return
          }
          sample = readExpectedPhase()
          if (sample.status === "switching") continue
          let blogFailure: string | undefined
          try {
            const blog = await fetch(`${WEB_URL}/blog`, { redirect: "manual", signal: AbortSignal.timeout(3_000) })
            if (blog.status !== 200 || !(blog.headers.get("content-type") ?? "").includes("text/html")) blogFailure = "Blog phase health did not return its public document"
            await blog.body?.cancel()
          } catch (error) { blogFailure = error instanceof Error ? error.message : String(error) }
          const after = readExpectedPhase()
          if (phaseProbeCrossed(sample, after, Date.now())) continue
          sample = after
          if (blogFailure) {
            const current = readLifecycleState(SERVICE_STATE_PATH)
            if (current) writeLifecycleState(SERVICE_STATE_PATH, failLifecycle(current, { service: "blog", kind: "health", at: new Date().toISOString(), detail: blogFailure }))
            stopHealthSupervisor()
            return
          }
        }
        const result = await hasExactHealth(service.healthUrl)
        if (manifest && sample && phaseProbeCrossed(sample, readExpectedPhase(), Date.now())) continue
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
    } catch (error) {
      const state = readLifecycleState(SERVICE_STATE_PATH)
      if (state) writeLifecycleState(SERVICE_STATE_PATH, failLifecycle(state, { service: "web-zones", kind: "health", at: new Date().toISOString(), detail: error instanceof Error ? error.message : String(error) }))
      stopHealthSupervisor()
    } finally {
      healthProbeInFlight = false
    }
  }
  healthSupervisor = setInterval(() => { void probe() }, 1_000)
  healthSupervisor.unref()
}

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
  const definitions = serviceDefinitions(SINGLE_RUNTIME)

  // Starting fresh — clear any orphaned dev servers on our ports first so a
  // prior crashed run doesn't leave 3000/8789 occupied (or get reused).
  const ports = (SINGLE_RUNTIME
    ? [portOf(WEB_URL), 3001, 3002, 8789, portOf(QUEUE_URL)]
    : definitions.map(({ healthUrl }) => portOf(healthUrl)))
    .filter((p): p is number => p != null)
  killPortOrphans(ports)
  // Give the OS a moment to release the sockets before we bind them.
  await new Promise((r) => setTimeout(r, 1000))
  const initialState = readLifecycleState(SERVICE_STATE_PATH)
  if (!initialState) throw new Error("service lifecycle state was not initialized")
  if (initialState.restorePending && !lstatSync(STATE_BACKUP_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("E2E state backup is missing before service startup")
  }
  resetDb()
  rmSync(SERVICE_LOG_DIR, { recursive: true, force: true })
  mkdirSync(SERVICE_LOG_DIR, { recursive: true })

  const services: ManagedService[] = []
  for (const definition of definitions) {
    const service = startService(definition)
    services.push(service)
    await waitForHealth(service)
  }

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
  let forced = false
  const dependencies: Parameters<typeof cleanupLifecycle>[1] = {
    terminate: (pid, signal) => {
      if (signal === "SIGKILL") forced = true
      try {
        process.kill(process.platform === "win32" ? pid : -pid, signal)
      } catch {
        return
      }
    },
    waitForStop: waitForProcessesToStop,
    restore: restoreState,
  }
  if (process.env.ALOOK_E2E_PUBLIC_STATIC_FORENSICS === "1") {
    await cleanupWithPublicStaticEvidence(stopping, {
      ...dependencies,
      capture: () => {
        const manifest = publicStaticQaManifest(false)
        if (!manifest) throw new Error("Forensic state capture requires a release manifest")
        const path = resolve(manifest.controlDirectory, "forensics-cleanup.private.json")
        const qualification = { forced, nativeTraceCompleteness: "UNKNOWN", physicalRelease: "INDEPENDENT_OPERATOR_CHECK_REQUIRED" }
        writeFileSync(path, `${JSON.stringify({ ...qualification, status: "capture-started" }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
        try {
          const receipt = capturePublicStaticRuntimeState({ runtimeRoot: REPO_ROOT, ownerRoot: AUTH_DIR, controlDirectory: manifest.controlDirectory, runId: manifest.runId, manifestDigest: manifest.digest })
          writeFileSync(path, `${JSON.stringify({ ...qualification, status: "captured", capture: receipt }, null, 2)}\n`)
        } catch (error) {
          try { writeFileSync(path, `${JSON.stringify({ ...qualification, status: "capture-failed" }, null, 2)}\n`) } catch (receiptError) {
            throw new AggregateError([error, receiptError], "Forensic capture and receipt failed")
          }
          throw error
        }
      },
      persist: stopped => writeLifecycleState(SERVICE_STATE_PATH, stopped),
    })
    return
  }
  const stopped = await cleanupLifecycle(stopping, dependencies)
  writeLifecycleState(SERVICE_STATE_PATH, stopped)
}
