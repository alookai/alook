import { spawn, spawnSync, type ChildProcess } from "child_process"
import { cpSync, existsSync, rmSync } from "fs"
import { resolve } from "path"
import { REPO_ROOT, WEB_URL, WS_URL } from "./paths"

export interface ManagedService {
  name: string
  proc: ChildProcess
  healthUrl: string
}

// Reuse a server the developer already has running (local iteration). CI
// always starts fresh, so REUSE is off there.
export const REUSE_EXISTING = !process.env.CI

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

export function resetDb(): void {
  const res = spawnSync("pnpm", ["run", "db:reset"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  })
  if (res.status !== 0) {
    throw new Error(`db:reset failed (exit ${res.status})`)
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
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // already gone
      }
    }
  }
}

function startService(name: string, filter: string, healthUrl: string): ManagedService {
  const proc = spawn("pnpm", ["--filter", filter, "dev"], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    detached: true,
  })
  return { name, proc, healthUrl }
}

// Starts web (:3000) + ws-do (:8789). Realtime journeys REQUIRE ws-do, so a
// missing ws health check is a hard failure (fail fast), never a silent
// degrade. Returns started services (empty when reusing an existing server).
export async function startServices(): Promise<ManagedService[]> {
  const webHealth = `${WEB_URL}/api/health`
  const wsHealth = `${WS_URL}/health`

  if (REUSE_EXISTING && (await isUp(webHealth)) && (await isUp(wsHealth))) {
    return []
  }

  // Starting fresh — clear any orphaned dev servers on our ports first so a
  // prior crashed run doesn't leave 3000/8789 occupied (or get reused).
  const ports = [portOf(WEB_URL), portOf(WS_URL)].filter((p): p is number => p != null)
  killPortOrphans(ports)
  // Give the OS a moment to release the sockets before we bind them.
  await new Promise((r) => setTimeout(r, 1000))

  const services = [
    startService("web", "@alook/web", webHealth),
    startService("ws-do", "@alook/ws-do", wsHealth),
  ]

  await Promise.all(services.map((s) => waitForHealth(s.healthUrl, s.name)))
  return services
}
