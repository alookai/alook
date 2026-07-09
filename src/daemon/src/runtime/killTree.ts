/**
 * Agent process spawn + process-tree termination with SIGKILL escalation.
 *
 * These two live together on purpose: they're opposite ends of the SAME
 * contract. `spawnAgentProcess` is the ONLY way a driver may start an agent
 * CLI — it always spawns `detached` on POSIX, making the child the leader of
 * its own process group (pgid = pid). That's what lets `killProcessTree`
 * signal the negative pid to reach the whole group — the CLI plus any MCP
 * servers / tool subprocesses it spawns — instead of just the leader, which
 * would otherwise leave grandchildren orphaned.
 *
 * Driver files must NOT call `child_process.spawn` directly for the agent CLI
 * — always go through `spawnAgentProcess` here, so the detached contract
 * can't be silently skipped by a new (or edited) driver.
 *
 * SIGTERM is a request; after a grace window we escalate to SIGKILL.
 */
import { spawn, type ChildProcess } from "child_process";

const POLL_MS = 100;
const DEFAULT_GRACE_MS = 2000;
const isPosix = process.platform !== "win32";

export interface AgentSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Run through a shell — needed on Windows for `.cmd`/`.bat` shims. */
  shell?: boolean;
}

/**
 * The only sanctioned way to spawn an agent CLI child process. Always pipes
 * stdio and (on POSIX) spawns `detached` so the child becomes its own
 * process-group leader — required for `killProcessTree`'s group signal to
 * actually reach it (and its grandchildren) instead of silently no-oping.
 * See the module doc comment above for why this must be the single spawn
 * entry point rather than each driver calling `child_process.spawn` itself.
 */
export function spawnAgentProcess(command: string, args: string[], opts: AgentSpawnOptions): ChildProcess {
  return spawn(command, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env,
    shell: opts.shell ?? false,
    detached: isPosix,
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Best-effort group signal, ALWAYS followed by a direct pid signal —
 * regardless of whether the group signal succeeded, threw `ESRCH` (no such
 * process group — e.g. the child wasn't spawned detached), or threw anything
 * else. A group signal failure must never be mistaken for "the pid is dead":
 * that conflates two unrelated failure semantics and was the root cause of a
 * bug where stopped agents kept running forever (see
 * plans/fix-daemon-agent-process-kill.md). Signaling an already-dead pid is
 * safe — it just throws ESRCH too, caught and ignored below.
 */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (isPosix) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Most commonly ESRCH (no such process group — not detached, or
      // already gone), but any failure here falls through the same way:
      // never treat it as proof the pid itself is dead.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already dead
  }
}

/**
 * Terminate `pid` and its descendants: group SIGTERM, then group SIGKILL after
 * `graceMs`. Returns promptly when the target is already dead.
 */
export async function killProcessTree(
  pid: number,
  opts?: { graceMs?: number },
): Promise<void> {
  if (!pid || pid < 1) return;
  if (!isAlive(pid)) return;

  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
  signalTree(pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (isAlive(pid)) {
    signalTree(pid, "SIGKILL");
  }
}
