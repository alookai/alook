/**
 * Process-tree termination with SIGKILL escalation.
 *
 * Inner agent CLIs (claude/codex/opencode) are spawned `detached:true` on POSIX
 * (see agent/*.ts), so each becomes the leader of its own process group whose id
 * equals its pid. Signalling the *negative* pid (`process.kill(-pid, ...)`) then
 * reaches the whole group — the CLI plus the MCP servers / tool subprocesses it
 * spawned — instead of just the leader. A plain positive-pid SIGTERM (the old
 * behaviour) leaves those grandchildren orphaned and burning CPU.
 *
 * SIGTERM is a request, not a guarantee: a wedged or signal-ignoring CLI keeps
 * running. So after a short grace window we escalate to SIGKILL.
 */

import { execSync } from "child_process";
import { createLogger } from "../lib/logger.js";

const log = createLogger({ module: "kill-tree" });

/** Session-runner grace before it escalates the inner-agent group to SIGKILL. */
export function killGraceMs(): number {
  return Number(process.env.ALOOK_KILL_GRACE_MS) || 2000;
}
const POLL_MS = 100;
const isPosix = process.platform !== "win32";

/** True while the process is alive; signal 0 probes without delivering a signal. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it — still "alive".
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Send `signal` to the whole process group; fall back to the plain pid. */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (isPosix) {
    try {
      // Negative pid = the process group led by `pid`.
      process.kill(-pid, signal);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") return; // group already gone
      // EPERM / no-group (legacy non-detached spawn): fall through to plain pid.
    }
  }
  if (!isPosix) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      return;
    } catch {
      // process may already be dead
    }
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already dead / not signalable — best-effort
  }
}

/**
 * Terminate `pid` and its descendants: group SIGTERM, then group SIGKILL if it
 * is still alive after `graceMs`. Never throws; returns promptly when the target
 * is already dead.
 */
export async function killProcessTree(
  pid: number,
  opts?: { graceMs?: number },
): Promise<void> {
  if (!pid || pid < 1) return;
  if (!isAlive(pid)) return;

  if (!isPosix) {
    // Windows: taskkill /T /F kills the entire tree, no grace needed
    signalTree(pid, "SIGTERM");
    return;
  }

  // POSIX: SIGTERM + grace + SIGKILL escalation
  const graceMs = opts?.graceMs ?? killGraceMs();
  signalTree(pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (isAlive(pid)) {
    log.warn(`pid=${pid} survived SIGTERM after ${graceMs}ms — escalating to SIGKILL`);
    signalTree(pid, "SIGKILL");
  }
}
